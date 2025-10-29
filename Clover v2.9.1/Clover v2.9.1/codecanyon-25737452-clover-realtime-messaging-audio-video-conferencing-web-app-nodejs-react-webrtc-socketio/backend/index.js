require('colors');

console.log(`${'Honeyside'.yellow} © ${'2022'.yellow}`);
console.log(`Welcome to ${'Clover'.cyan}`);

const express = require('express');
const app = express();
const http = require('http');
const io = require('socket.io');
const store = require('./src/store');
const init = require('./src/init');
const mediasoup = require('./src/mediasoup');
const schedule = require('node-schedule');
const Email = require('./src/models/Email');
const sendMail = require('./src/utils/sendMail');

Config = require('./config');
if (Config.ip) Config.mediasoup.webRtcTransport.listenIps[0].ip = Config.ip;

// ❌ Disable DB block middleware for Render
// app.use((req, res, next) => (store.connected ? next() : res.status(500).send('Database not available.')));

// Serve static frontend (optional)
app.use(express.static(`${__dirname}/../frontend/dist`));
app.use('/login', express.static(`${__dirname}/../frontend/dist`));
app.use('/login/*', express.static(`${__dirname}/../frontend/dist`));
app.use('/admin', express.static(`${__dirname}/../frontend/dist`));
app.use('/room/*', express.static(`${__dirname}/../frontend/dist`));
app.use('/meeting/*', express.static(`${__dirname}/../frontend/dist`));

const server = http.createServer(app);
store.app = app;
store.config = Config;
store.io = io(server);

init();
mediasoup.init();

// ✅ Fix: use Render’s PORT variable
const PORT = process.env.PORT || Config.port || 4000;
const HOST = '0.0.0.0';

const listen = () => {
  server.listen(PORT, HOST, () => console.log(`🚀 Server running on port ${PORT}`.green));
};

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Specified port unavailable, retrying in 10 seconds...'.red);
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, Config.retryAfter);
  }
});

listen();

// Mailer cron job (optional)
let scheduler;
let schedulerDone = false;

if (Config.nodemailerEnabled) {
  if (!scheduler)
    scheduler = schedule.scheduleJob('*/5 * * * * *', async () => {
      if (schedulerDone) return;
      schedulerDone = true;

      const emails = await Email.find({ sent: false });

      for (let email of emails) {
        try {
          await sendMail({
            from: email.from,
            to: email.to,
            subject: email.subject,
            html: `${email.html}`,
          });
          const entry = await Email.findById(email._id);
          entry.sent = true;
          entry.dateSent = Date.now();
          await entry.save();
        } catch (e) {
          console.log(e);
        }
      }

      schedulerDone = false;
    });
}
