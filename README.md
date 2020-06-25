# GT Server

> GroupwareToolkit Server

## Build Setup

```bash
# install dependencies
$ npm install

# run in a dev setup.
$ npm run dev

# start the server.
$ npm run start
```

This is the server for the Groupware Toolkit.

The goal is to have developers quickly create realtime applications without the worry of sockets and transports.

It currently uses Express and Socket.io.

The server is completely independent of client logic and is only keeping a collective state for the users and rooms.


## Usage

This is just the server and is designed to just be ran somewhere. Once you got the server running, use the client (https://github.com/mrd875/GroupwareToolkitClient) to start using the project.
