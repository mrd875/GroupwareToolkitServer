const http = require('http')

const express = require('express')
const consola = require('consola')

const socketio = require('socket.io')
const _ = require('lodash')

const app = express()
const server = http.createServer(app)
const io = socketio(server)

// set static folder
app.use(express.static('public'))

const port = process.env.PORT || 3000

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

// all the states for each room.
// key'd by room name, value being the room's state.
let rooms = {}
let users = {}

// debug http endpoints to view the state.
app.get('/rooms', (req, res) => {
  res.json(rooms)
})
app.get('/room', (req, res) => {
  res.json(getUsersFromRoom(''))
})
app.get('/room/:id', (req, res) => {
  res.json(getUsersFromRoom(req.params.id))
})
app.get('/clear', (req, res) => {
  rooms = {}
  users = {}
  res.sendStatus(200)
})

// listen for a connection.
io.on('connection', socket => {
  consola.log(`${socket.id} has connected.`)

  // set the socket's state to just connected.
  socket.conn_state = CONN_STATES.CONNECTED

  // when we receive an auth packet.
  socket.on('auth', (authPayload) => {
    consola.log(`${socket.id} send auth: ${authPayload}`)

    // check and see if the socket is in the correct state to send this type of packet
    if (socket.conn_state !== CONN_STATES.CONNECTED) {
      socket.error({
        message: 'Need to be in the CONNECTED state to send auth packet',
        type: 'auth'
      })
      return
    }

    // ok got auth packet, validate it and move on..
    if (typeof authPayload !== 'object') {
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

    consola.log(`${socket.id} is authed as ${id}`)

    // tell user that they are authed
    socket.emit('authed', userObj)
  })


  // when a user wants to join a room
  socket.on('join', (joinPayload, userPayload) => {
    consola.log(`${socket.id} is joining room: ${joinPayload}, ${userPayload}`)

    if (socket.conn_state !== CONN_STATES.AUTHED) {
      socket.error({ type: 'join', message: 'Need to be in the AUTHED state to send this type of packet' })
      return
    }

    if (typeof joinPayload !== 'object') {
      socket.error({ type: 'join', message: 'Join packet was not an object' })
      return
    }

    // validate join obj
    const room = joinPayload.room
    if (typeof room !== 'string') {
      socket.error({ type: 'join', message: 'No \'room\' in join packet' })
      return
    }

    const id = socket.auth_id
    const userObj = users[id]

    // apply the user payload from the user
    if (userPayload !== undefined && typeof userPayload === 'object') userObj.state = userPayload

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

      // tell everyone someone connected
      io.to(room).emit('connected', id, userObj.state)

      // notify new user of the current state...
      socket.emit('joined', room, roomObj.state, getUsersFromRoom(room))
    })
  })

  socket.on('leaveroom', () => {
    consola.log(`${socket.id} is leaving room`)

    if (socket.conn_state !== CONN_STATES.INROOM) {
      socket.error({ type: 'leaveroom', message: 'Need to be in the INROOM state to send this type of packet' })
      return
    }

    const id = socket.auth_id
    const userObj = users[id]

    const room = userObj.room

    socket.leave(room, () => {
      io.to(room).emit('disconnected', id, 'left')
      userObj.room = undefined

      socket.conn_state = CONN_STATES.AUTHED

      socket.emit('leftroom', 'user initiated')
    })
  })

  const onUserUpdate = (e, msg) => {
    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_user', message: 'You need to be in a room' }); return }
    if (typeof e !== 'object') { socket.error({ type: 'update_user', message: 'Update payload needs to be an object' }); return }

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

    consola.log('Got a', msg, 'from', socket.id, 'in', room, 'being', e)

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

  const onStateUpdate = (e, msg) => {
    if (socket.conn_state !== CONN_STATES.INROOM) { socket.error({ type: 'update_state', message: 'You need to be in a room' }); return }
    if (typeof e !== 'object') { socket.error({ type: 'update_state', message: 'Update payload needs to be an object' }); return }

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

    consola.log('Got a', msg, 'from', id, 'in', room, 'being', e)

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

  socket.once('disconnect', reason => {
    consola.log(`${socket.id} has disconnected (${reason}).`)

    if (socket.conn_state !== CONN_STATES.CONNECTED) {
      const id = socket.auth_id
      const userObj = users[id]

      userObj.online = false

      if (socket.conn_state === CONN_STATES.INROOM) {
        const room = userObj.room

        io.to(room).emit('disconnected', id, reason)
        userObj.room = undefined
      }
    }
  })
})

server.listen(port, () =>
  consola.ready({
    message: `Server listening on port ${port}`,
    badge: true
  })
)
