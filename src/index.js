const http = require('http')
const path = require('path')

const express = require('express')
const consola = require('consola')

const socketio = require('socket.io')
const _ = require('lodash')

const app = express()
const server = http.createServer(app)
const io = socketio(server)

// set static folder
app.use(express.static(path.join(__dirname, 'public')))

// the time at which unreliable messages will collapse and queue and then fire.
const BURST_DELAY = 50 // ms, 20 tickrate

// the time at which a client has to send a join room message after connecting.
// the client will be kicked after if they didn't join a room.
const NO_ROOM_TIME = 10000

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
  const users = {}

  userIds.forEach(uId => {
    users[uId] = io.sockets.sockets[uId].state
  })

  return users
}

// all the states for each room.
// key'd by room name, value being the room's state.
let rooms = {}

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
  res.sendStatus(200)
})

// listen for a connection.
io.on('connection', socket => {
  consola.log(`${socket.id} has connected.`)

  // init the state of the user
  socket.state = {}

  // kick the client if they dont join a room.
  const kickOnNoRoom = setTimeout(() => {
    socket.disconnect()
  }, NO_ROOM_TIME)

  // now we need to get what room the client wants in on.
  socket.once('join_room', (room, userPayload) => {
    consola.log(`${socket.id} is joining room: ${room}, ${userPayload}`)

    // have the socket join the room
    socket.join(room, () => {
      clearTimeout(kickOnNoRoom) // disable the kick

      // set user state if passed with one.
      if (userPayload) {
        socket.state = userPayload
      }

      // init the state of the room
      if (!rooms[room]) {
        rooms[room] = {}
      }
      const roomObj = rooms[room] // io.sockets.adapter.rooms[room]
      if (!roomObj.state) {
        roomObj.state = {}
      }

      // tell everyone someone connected
      io.to(room).emit('connected', socket.id, socket.state)

      // notify new user of the current state...
      socket.emit('init_state', roomObj.state, getUsersFromRoom(room), room)

      // listen for messages now...

      const onUserUpdate = (e, msg) => {
        // ignore non object messages
        if (typeof e !== 'object') {
          return
        }

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

        consola.log('Got a', msg, 'from', socket.id, 'in room', room, 'being:', e)

        const sendAndLock = payloadDelta => {
          if (!payloadDelta) {
            return
          }

          // update our state
          _.merge(socket.state, payloadDelta)
          // remove null keys...
          socket.state = removeObjectsWithNull(socket.state)

          // send it out.
          io.to(room).emit(msg, socket.id, payloadDelta)
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
        // ignore non object messages
        if (typeof e !== 'object') {
          return
        }

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

        consola.log('Got a', msg, 'from', socket.id, 'in room', room, 'being:', e)

        const sendAndLock = payloadDelta => {
          if (!payloadDelta) {
            return
          }

          // update our state
          _.merge(roomObj.state, payloadDelta)
          // remove null keys...
          roomObj.state = removeObjectsWithNull(roomObj.state)

          // send it out.
          io.to(room).emit(msg, socket.id, payloadDelta)
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
        // tell everyone someone disconnected
        io.to(room).emit('disconnected', socket.id, reason)
      })
    })
  })

  socket.once('disconnect', reason => {
    consola.log(`${socket.id} has disconnected (${reason}).`)
  })
})

const port = process.env.PORT || 3000

server.listen(port, () =>
  consola.ready({
    message: `Server listening on port ${port}`,
    badge: true
  })
)
