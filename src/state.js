const fs = require('fs')
const consola = require('consola')
const { promisify } = require('util')

const writeFile = promisify(fs.writeFile)

const FLUSH_TO_DISK = 60000
const pathToState = './state'
const pathToUsers = pathToState + '/users.json'
const pathToRooms = pathToState + '/rooms.json'

try {
  fs.mkdirSync(pathToState)
} catch {}

// read the users json file.
let users
try {
  const usersJsonText = fs.readFileSync(pathToUsers, 'utf-8')
  const usersJsonParsed = JSON.parse(usersJsonText)

  // now we need to strip the session data as no one is currently online.
  for (const k in usersJsonParsed) {
    const user = usersJsonParsed[k]
    user.online = false
    user.room = undefined
  }

  consola.log('Users json file loaded.')
  users = usersJsonParsed
} catch (err) {
  consola.log('Error reading users json file, starting fresh...', err.toString())
  users = {}
}

// read the rooms json file.
let rooms
try {
  const roomsJsonText = fs.readFileSync(pathToRooms, 'utf-8')
  const roomsJsonParsed = JSON.parse(roomsJsonText)

  consola.log('Rooms json file loaded.')
  rooms = roomsJsonParsed
} catch (err) {
  consola.log('Error reading rooms json file, starting fresh...', err.toString())
  rooms = {}
}

// flush the state to the disk after an interval.
setInterval(async () => {
  try {
    consola.log('Flushing users to disk...')
    const usersToText = JSON.stringify(users)
    await writeFile(pathToUsers, usersToText)
    consola.log('Completed flushing users to disk.')
  } catch (err) {
    consola.err(err)
  }

  try {
    consola.log('Flushing rooms to disk...')
    const roomsToText = JSON.stringify(rooms)
    await writeFile(pathToRooms, roomsToText)
    consola.log('Completed flushing rooms to disk.')
  } catch (err) {
    consola.err(err)
  }
}, FLUSH_TO_DISK)

// expose the objects
module.exports = {
  users, rooms
}
