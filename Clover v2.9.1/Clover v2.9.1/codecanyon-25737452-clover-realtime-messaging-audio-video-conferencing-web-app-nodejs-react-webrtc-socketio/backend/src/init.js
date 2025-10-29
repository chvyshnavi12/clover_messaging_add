const store = require('./store');
const events = require('./events');
const socketioJwt = require('socketio-jwt');
const cors = require('cors');
const router = require('./routes');
const formidableMiddleware = require('express-formidable');
const mongoose = require('mongoose');
const User = require('./models/User');
const argon2 = require('argon2');
const passport = require('passport');
const { Strategy, ExtractJwt } = require('passport-jwt');
const { AsyncNedb } = require('nedb-async');
const mediasoup = require('./mediasoup');
const Meeting = require('./models/Meeting');

module.exports = () => {
  // Initialize in-memory data
  store.rooms = new AsyncNedb();
  store.peers = new AsyncNedb();
  store.onlineUsers = new Map();

  // Socket.io authentication setup
  store.io.sockets
    .on(
      'connection',
      socketioJwt.authorize({
        secret: store.config.secret,
        timeout: 15000, // 15 seconds to send the authentication message
      }),
    )
    .on('authenticated', (socket) => {
      const { email, id } = socket.decoded_token;
      console.log(`Socket connected: ${email}`.cyan);

      mediasoup.initSocket(socket);
      socket.join(id);

      events.forEach((event) => socket.on(event.tag, (data) => event.callback(socket, data)));

      // Store socket info
      store.socketIds.push(socket.id);
      store.sockets[socket.id] = socket;
      if (!store.socketsByUserID[id]) store.socketsByUserID[id] = [];
      store.socketsByUserID[id].push(socket);
      store.userIDsBySocketID[socket.id] = id;

      // Track online users
      store.onlineUsers.set(socket, { id, status: 'online' });
      store.io.emit('onlineUsers', Array.from(store.onlineUsers.values()));

      // Handle disconnects
      socket.on('disconnect', () => {
        if (store.roomIDs[socket.id]) {
          let roomID = store.roomIDs[socket.id];
          store.consumerUserIDs[roomID].splice(store.consumerUserIDs[roomID].indexOf(socket.id), 1);
          socket.to(roomID).emit('consumers', { content: store.consumerUserIDs[roomID], timestamp: Date.now() });
          socket.to(roomID).emit('leave', { socketID: socket.id });
        }

        Meeting.update({}, { $pull: { peers: socket.id } }, { multi: true });

        store.peers.remove({ socketID: socket.id }, { multi: true });
        console.log(`Socket disconnected: ${email}`.cyan);

        store.socketIds.splice(store.socketIds.indexOf(socket.id), 1);
        store.sockets[socket.id] = undefined;

        const removeSocket = (array, element) => array.filter((s) => s.id !== element.id);
        store.socketsByUserID[id] = removeSocket(store.socketsByUserID[id], socket);

        User.findOneAndUpdate({ _id: id }, { $set: { lastOnline: Date.now() } })
          .then(() => console.log('Last online updated: ' + id))
          .catch((err) => console.log(err));

        store.onlineUsers.delete(socket);
        store.io.emit('onlineUsers', Array.from(store.onlineUsers.values()));
      });
    });

  // Express middlewares
  store.app.use(cors());
  store.app.use(formidableMiddleware());
  store.app.use(passport.initialize());

  // JWT Auth strategy
  passport.use(
    'jwt',
    new Strategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: store.config.secret,
      },
      (payload, done) => {
        User.findById(payload.id)
          .then((user) => (user ? done(null, user) : done(null, false)))
          .catch((err) => console.log(err));
      },
    ),
  );

  store.app.use('/api', router);

  // MongoDB connection
  const mongooseConnect = async () => {
  console.log("🟡 Connecting to MongoDB...");

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ Missing MONGO_URI in .env file");
    return;
  }

  mongoose.set('strictQuery', false);

  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    const { ROOT_USER_USERNAME, ROOT_USER_EMAIL, ROOT_USER_PASSWORD, ROOT_USER_FIRST_NAME, ROOT_USER_LAST_NAME } =
      process.env;

    const existingUser = await User.findOne({ email: ROOT_USER_EMAIL });
    const hash = await argon2.hash(ROOT_USER_PASSWORD);

    if (!existingUser) {
      await new User({
        username: ROOT_USER_USERNAME,
        email: ROOT_USER_EMAIL,
        password: hash,
        firstName: ROOT_USER_FIRST_NAME,
        lastName: ROOT_USER_LAST_NAME,
        level: 'root',
      }).save();
      console.log("🆕 Root user created");
    } else {
      console.log("ℹ️ Root user already exists");
    }

    await Meeting.updateMany({}, { $set: { peers: [] } });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    console.log("Retrying in 10 seconds...");
    setTimeout(mongooseConnect, 10 * 1000);
  }
};



  mongooseConnect();
};
