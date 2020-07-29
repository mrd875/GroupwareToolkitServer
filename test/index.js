const assert = require('chai').assert
const GT = require('gt-client')
const io = require('../src/io')
const consola = require('consola')

const servUrl = 'http://localhost:3000'

describe('Server testing', () => {
  before(function (done) {
    this.server = io.listen(3000)
    consola.log('Server listening...')
    done()
  })

  after(function (done) {
    consola.log('Closing server...')
    this.server.close()
    done()
  })

  it('Can connect', async function () {
    this.gt = new GT(servUrl)

    assert(!this.gt.isConnected())
    assert(!this.gt.isAuthed())
    assert(!this.gt.isInRoom())

    await this.gt.connect()

    assert(this.gt.isConnected())
    assert(!this.gt.isAuthed())
    assert(!this.gt.isInRoom())
  })
})
