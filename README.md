# GTGT

> GT Playground

## Build Setup

```bash
# install dependencies
$ npm install

# serve with hot reload at localhost:3000
$ npm run dev

# build for production and launch server
$ npm run build
$ npm run start

# generate static project
$ npm run generate
```

For detailed explanation on how things work, check out [Nuxt.js docs](https://nuxtjs.org).

Realtime web app with websockets using Node.js, Express and Socket.io with Vanilla JS on the frontend with Konva.

The Node Server will be running and will host the client at http://localhost:3000

This is an example of a realtime web app with a few features:
- Rooms
- Cursors on the canvas
- Drawing lines on the canvas by dragging
- Deleting lines on the canvas by clicking
- Text areas
- Listing users with synced usernames

Choose a room to join, choose a username, and click connect.

## How it works

This is a socket.io server/client application. Its designed to abstract away communication of messages from a foreign source from developers.

The server is completely independent of client logic and is only keeping a collective state for the users and rooms.

First of all, we have a socket.io server, listening for connections. Once the server recieves a connection, its going to expect a message from the newly connected client.

The server is going to expect a ('join_room', room_name, user_payload) message.
The room_name being the room the user wants to join, and the user_payload being an optional starting user state.

Then a ('connected', user_id, user_state) message will be emitted to everyone in the room.
The user_id being the unique socket.id of the user that just joined the room, and the user_state being the state of the user.

After, a ('init_state', room_state, user_states, room_name) will be emitted to the new client.
room_state is the current state of the room. user_states is the state of all the users in the room, and room_name being the name of the room.

When the user disconnects from the socket server, a ('disconnected', user_id, reason) message will be emitted to everyone in the room.
user_id being the user's id who disconnected and the reason being a technical reason why they left.


The server will now listen for two types of messages from the connected client. A user updated and state updated message.

A user update message will apply a payload to the sender's state.
A state update message will apply a payload to the room's state.

Each of these types will have two different types of messages, a reliable and unreliable message.
A reliable message will be sent, processed and replied to as fast as possible.
An unreliable message will be sent, and for a small amount of time, any other unreliable messages will be condensed and queued until the time is up. 
Once the time is up, it'll then be processed and replied to.

The payloads being sent with these messages will always be deltas, the deltas will be merged into the respected states it is supposed to part of.
If the payload contains any null value'd keys, these keys will be removed from the server's state.
A reply will be emitted to all users within the room, containing the same delta object that the server received.



It will be entirely up to the clients (developers) to keep track of the state and messages they receive from the server, they receive enough information from the server so that they will be able to keep track and keep a consistent application going.

A developer can use the GT object on the client side to communicate with the server. The GT object will emit events to the developer and allow developers to send messages.

