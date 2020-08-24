const consola = require('consola')

const socketio = require('socket.io')
const _ = require('lodash')

const io = socketio()

// the time at which unreliable messages will collapse and queue and then fire.
const BURST_DELAY = 50 // ms, 20 tickrate

// States that a socket can take,
// CONNECTED is connected but not authed,
// AUTHED is authenticated but not in a room
// INROOM is in a room.
const CONN_STATES = {
  CONNECTED: 'connected',
  AUTHED: 'authed',
  INROOM: 'in room'
}

// all the states for each room.
// key'd by room name, value being the room's state.
const { rooms, users } = require('./state.js')

const validPackets = {
  user_updated_reliable: true,
  user_updated_unreliable: true,
  state_updated_unreliable: true,
  state_updated_reliable: true,
  state_updated_batched: true,
  user_updated_batched: true,
  leaveroom: true,
  join: true,
  auth: true
}

// https://stackoverflow.com/questions/30812765/how-to-remove-undefined-and-null-values-from-an-object-using-lodash/31209300
// returns the object that has all null value'd keys removed.
const removeObjectsWithNull = obj => {
  return _(obj)
    .pickBy(_.isObject) // get only objects
    .mapValues(removeObjectsWithNull) // call only for values as objects
    .assign(_.omitBy(obj, _.isObject)) // save back result that is not object
    .omitBy(_.isNil) // remove null and undefined from object
    .value() // get value
}

// return true if the object is an object.
const isObject = obj => {
  return obj !== undefined && obj !== null && typeof obj === 'object' && !Array.isArray(obj)
}

// returns all users for the given room.
// key'd by userId, value being the user's state.
const getUsersFromRoom = room => {
  if (!io.sockets.adapter.rooms[room]) {
    return null
  }
  const userIds = Object.keys(io.sockets.adapter.rooms[room].sockets)
  const us = {}

  userIds.forEach(uId => {
    const id = io.sockets.sockets[uId].auth_id

    if (!id) return

    us[id] = users[id].state
  })

  return us
}

// listen for a connection.
io.on('connection', socket => {
  consola.info(`${socket.id} has connected.`)

  // set the socket's state to just connected.
  socket.conn_state = CONN_STATES.CONNECTED

  // when we receive an auth packet.
  socket.on('auth', (authPayload) => {
    // check and see if the socket is in the correct state to send this type of packet
    if (socket.conn_state !== CONN_STATES.CONNECTED) {
      socket.error({
        message: 'Need to be in the CONNECTED state to send auth packet',
        type: 'auth'
      })
      return
    }

    // ok got auth packet, validate it and move on..
    if (!isObject(authPayload)) {
      socket.error({ message: 'Auth packet was not an object', type: 'auth' })
      return
    }

    const id = authPayload.id
    if (typeof id !== 'string') {
      socket.error({ message: 'No valid \'id\' found in auth packet', type: 'auth' })
      return
    }

    // init the user state
    if (!users[id]) {
      users[id] = {
        id,
        state: {},
        room: undefined,
        online: false
      }
    }
    const userObj = users[id]

    // make sure the user isn't already online.
    if (userObj.online) {
      socket.error({ message: 'id is already online', type: 'auth' })
      return
    }

    // auth the socket.
    socket.auth_id = id
    userObj.online = true
    socket.conn_state = CONN_STATES.AUTHED

    consola.info(`${socket.id} is authed as ${id}`)

    // tell user that they are authed
    socket.emit('authed', userObj)
  })

  // when a user wants to join a room
  socket.on('join', (joinPayload, userPayload) => {
    // check to see if the user can send this type of packet.
    if (socket.conn_state !== CONN_STATES.AUTHED) {
      socket.error({ type: 'join', message: 'Need to be in the AUTHED state to send this type of packet' })
      return
    }

    // validate join obj
    if (!isObject(joinPayload)) {
      socket.error({ type: 'join', message: 'Join packet was not an object' })
      return
    }

    const room = joinPayload.room
    if (typeof room !== 'string') {
      socket.error({ type: 'join', message: 'No \'room\' in join packet' })
      return
    }

    const id = socket.auth_id
    const userObj = users[id]

    // apply the user payload from the user
    if (isObject(userPayload)) userObj.state = userPayload

    // have the socket join the room
    socket.join(room, () => {
      // init the state of the room
      if (!rooms[room]) {
        rooms[room] = {
          state: {},
          room
        }
      }
      const roomObj = rooms[room]

      userObj.room = room
      socket.conn_state = CONN_STATES.INROOM

      consola.info(`${socket.id} joined room ${room}`)

      // notify new user of the current state...
      socket.emit('joined', room, roomObj.state, getUsersFromRoom(room))

      // tell everyone someone connected
      io.to(room).emit('connected', id, userObj.state)
    })
  })

  // when the user sends us a leave room packet.
  socket.on('leaveroom', () => {
    // see if the user can send this type of packet.
    if (socket.conn_state !== CONN_STATES.INROOM) {
      socket.error({ type: 'leaveroom', message: 'Need to be in the INROOM state to send this type of packet' })
      return
    }

    const id = socket.auth_id
    const userObj = users[id]

    const room = userObj.room

    // leave the room.
    socket.leave(room, () => {
      consola.info(`${socket.id} left room`)

      io.to(room).emit('disconnected', id, 'left')
      userObj.room = undefined

      socket.conn_state = CONN_STATES.AUTHED

      socket.emit('leftroom', 'user initiated')
    })
  })

  const onUserUpdate = (e, msg) => {
    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_user', message: 'You need to be in a room' }); return }
    if (!isObject(e)) { socket.error({ type: 'update_user', message: 'Update payload needs to be an object' }); return }

    if (msg === 'user_updated_unreliable') {
      // check if the burst is locked
      if (socket.user_burst_locked) {
        if (!socket.user_burst_payload) {
          socket.user_burst_payload = e
        } else {
          // remember the last payload...
          _.merge(socket.user_burst_payload, e)
        }

        return
      }
    }

    const id = socket.auth_id
    const userObj = users[id]
    const room = userObj.room

    const sendAndLock = payloadDelta => {
      if (!payloadDelta) {
        return
      }

      // update our state
      _.merge(userObj.state, payloadDelta)
      // remove null keys...
      userObj.state = removeObjectsWithNull(userObj.state)

      // send it out.
      io.to(room).emit(msg, id, payloadDelta)
      // its up to the client to remove the null values to keep their state consistent.

      if (msg === 'user_updated_unreliable') {
        // lock the burst
        socket.user_burst_locked = true
        // wait for the burst delay
        setTimeout(() => {
          // then unlock the burst
          socket.user_burst_locked = undefined

          // send the last payload
          sendAndLock(socket.user_burst_payload)
          socket.user_burst_payload = undefined
        }, BURST_DELAY)
      }
    }

    sendAndLock(e)
  }

  socket.on('user_updated_reliable', e => {
    onUserUpdate(e, 'user_updated_reliable')
  })

  socket.on('user_updated_unreliable', e => {
    onUserUpdate(e, 'user_updated_unreliable')
  })

  socket.on('user_updated_batched', e => {
    // e should be an array
    // we will have the client do the rate limit, hopefully no one exploits this

    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_state', message: 'You need to be in a room' }); return }
    if (!Array.isArray(e) || e.length <= 0) { socket.error({ type: 'update_state', message: 'Update payload needs to be an array' }); return }

    // now we need to open up the array,
    // each element should be a single message update.
    for (const i in e) {
      const msg = e[i]

      if (!isObject(msg)) { socket.error({ type: 'update_user', message: 'Update payload needs to be an object' }); return }
    }

    // ok we vaildated the payload, now lets apply the changes in order.

    const id = socket.auth_id
    const userObj = users[id]
    const room = userObj.room

    for (const i in e) {
      const msg = e[i]

      // update our state
      _.merge(userObj.state, msg)
      // remove null keys...
      userObj.state = removeObjectsWithNull(userObj.state)
    }

    // ok the state has been applied inorder.
    // now propergate the message to everyone.
    io.to(room).emit('user_updated_batched', id, e)
  })

  const onStateUpdate = (e, msg) => {
    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_state', message: 'You need to be in a room' }); return }
    if (!isObject(e)) { socket.error({ type: 'update_state', message: 'Update payload needs to be an object' }); return }

    if (msg === 'state_updated_unreliable') {
      // check if the burst is locked
      if (socket.state_burst_locked) {
        if (!socket.state_burst_payload) {
          socket.state_burst_payload = e
        } else {
          // remember the last payload...
          _.merge(socket.state_burst_payload, e)
        }

        return
      }
    }

    const id = socket.auth_id
    const userObj = users[id]
    const room = userObj.room
    const roomObj = rooms[room]

    const sendAndLock = payloadDelta => {
      if (!payloadDelta) {
        return
      }

      // update our state
      _.merge(roomObj.state, payloadDelta)
      // remove null keys...
      roomObj.state = removeObjectsWithNull(roomObj.state)

      // send it out.
      io.to(room).emit(msg, id, payloadDelta)
      // its up to the client to remove the null values to keep their state consistent.

      if (msg === 'state_updated_unreliable') {
        // lock the burst
        socket.state_burst_locked = true
        // wait for the burst delay
        setTimeout(() => {
          // then unlock the burst
          socket.state_burst_locked = undefined

          // send the last payload
          sendAndLock(socket.state_burst_payload)
          socket.state_burst_payload = undefined
        }, BURST_DELAY)
      }
    }

    sendAndLock(e)
  }

  socket.on('state_updated_unreliable', e => {
    onStateUpdate(e, 'state_updated_unreliable')
  })

  socket.on('state_updated_reliable', e => {
    onStateUpdate(e, 'state_updated_reliable')
  })

  socket.on('state_updated_batched', e => {
    // e should be an array
    // we will have the client do the rate limit, hopefully no one exploits this

    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_state', message: 'You need to be in a room' }); return }
    if (!Array.isArray(e) || e.length <= 0) { socket.error({ type: 'update_state', message: 'Update payload needs to be an array' }); return }

    // now we need to open up the array,
    // each element should be a single message update.
    for (const i in e) {
      const msg = e[i]

      if (!isObject(msg)) { socket.error({ type: 'update_state', message: 'Update payload needs to be an object' }); return }
    }

    // ok we vaildated the payload, now lets apply the changes in order.

    const id = socket.auth_id
    const userObj = users[id]
    const room = userObj.room
    const roomObj = rooms[room]

    for (const i in e) {
      const msg = e[i]

      // update our state
      _.merge(roomObj.state, msg)
      // remove null keys...
      roomObj.state = removeObjectsWithNull(roomObj.state)
    }

    // ok the state has been applied inorder.
    // now propergate the message to everyone.
    io.to(room).emit('state_updated_batched', id, e)
  })

  // middleware..
  socket.use((packet, next) => {
    const [pType, ...args] = packet

    if (!(pType in validPackets)) {
      socket.error({ type: 'packet', message: 'invalid packet type' })
      consola.log('Bad packet type:', pType)
      return
    }

    consola.info(pType, args)
    return next()
  })

  // when the user disconnects.
  socket.once('disconnect', reason => {
    consola.info(`${socket.id} has disconnected (${reason}).`)

    // check if the user is authed.
    if (socket.conn_state !== CONN_STATES.CONNECTED) {
      const id = socket.auth_id
      const userObj = users[id]

      // make the user offline.
      userObj.online = false

      // check if they were in a room
      if (socket.conn_state === CONN_STATES.INROOM) {
        // tell everyone they left the room.
        const room = userObj.room

        io.to(room).emit('disconnected', id, reason)
        userObj.room = undefined
      }
    }
  })
})

module.exports = io
