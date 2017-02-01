'use strict'

var dgram = require('dgram')
var crypto = require('crypto')
var bencode = require('bencode')

const BOOTSTRAP_NODES = [
    ['router.bittorrent.com', 6881],
    ['router.utorrent.com', 6881],
    ['dht.transmissionbt.com', 6881]
]
const TID_LENGTH = 4
const NODES_MAX_SIZE = 200
const TOKEN_LENGTH = 2

const randomID = () => crypto.createHash('sha1').update(crypto.randomBytes(20)).digest()

const decodeNodes = data => {
    const nodes = []
    for (let i = 0; i + 26 <= data.length; i += 26) {
        nodes.push({
            nid: data.slice(i, i + 20),
            address: `${data[i + 20]}.${data[i + 21]}.${data[i + 22]}.${data[i + 23]}`,
            port: data.readUInt16BE(i + 24)
        })
    }
    return nodes
}

const genNeighborID = (target, nid) => Buffer.concat([target.slice(0, 10), nid.slice(10)])

class KTable {
    constructor(maxsize) {
        this.nid = randomID()
        this.nodes = []
        this.maxsize = maxsize
    }

    push(node) {
        if (this.nodes.length >= this.maxsize) {
            return
        }
        this.nodes.push(node)
    }
}

class DHTSpider {
    constructor(options) {
        this.address = options.address
        this.port = options.port
        this.udp = dgram.createSocket('udp4')
        this.ktable = new KTable(NODES_MAX_SIZE)
    }

    sendKRPC(msg, rinfo) {
        const buf = bencode.encode(msg)
        this.udp.send(buf, 0, buf.length, rinfo.port, rinfo.address)
    }

    onFindNodeResponse(nodes) {
        var nodes = decodeNodes(nodes)
        nodes.forEach(node => {
            if (node.address != this.address && node.nid != this.ktable.nid
                    && node.port < 65536 && node.port > 0) {
                this.ktable.push(node)
            }
        })
    }

    sendFindNodeRequest(rinfo, nid) {
        const _nid = nid != undefined ? genNeighborID(nid, this.ktable.nid) : this.ktable.nid
        const msg = {
            t: randomID().slice(0, TID_LENGTH),
            y: 'q',
            q: 'find_node',
            a: {
                id: _nid,
                target: randomID()
            }
        }
        this.sendKRPC(msg, rinfo)
    }

    joinDHTNetwork() {
        BOOTSTRAP_NODES.forEach(node => {
            this.sendFindNodeRequest({address: node[0], port: node[1]})
        })
    }

    makeNeighbours() {
        this.ktable.nodes.forEach(node => {
            this.sendFindNodeRequest({
                address: node.address,
                port: node.port
            }, node.nid)
        })
        this.ktable.nodes = []
    }

    onGetPeersRequest(msg, rinfo) {
        try {
            var infohash = msg.a.info_hash
            var tid = msg.t
            const nid = msg.a.id
            var token = infohash.slice(0, TOKEN_LENGTH)

            if (tid === undefined || infohash.length != 20 || nid.length != 20) {
                throw new Error
            }
        }
        catch (err) {
            return
        }
        this.sendKRPC({
            t: tid,
            y: 'r',
            r: {
                id: genNeighborID(infohash, this.ktable.nid),
                nodes: '',
                token
            }
        }, rinfo)
    }

    onAnnouncePeerRequest(msg, rinfo) {
        let port

        try {
            var infohash = msg.a.info_hash
            var token = msg.a.token
            var nid = msg.a.id
            var tid = msg.t

            if (tid == undefined) {
                throw new Error
            }
        }
        catch (err) {
            return
        }

        if (infohash.slice(0, TOKEN_LENGTH).toString() != token.toString()) {
            return
        }

        if (msg.a.implied_port != undefined && msg.a.implied_port != 0) {
            port = rinfo.port
        }
        else {
            port = msg.a.port || 0
        }

        if (port >= 65536 || port <= 0) {
            return
        }

        this.sendKRPC({
            t: tid,
            y: 'r',
            r: {
                id: genNeighborID(nid, this.ktable.nid)
            }
        }, rinfo)

        console.log("magnet:?xt=urn:btih:%s from %s:%s", infohash.toString("hex"), rinfo.address, rinfo.port)
    }

    onMessage(msg, rinfo) {
        try {
            var msg = bencode.decode(msg)
            if (msg.y == 'r' && msg.r.nodes) {
                this.onFindNodeResponse(msg.r.nodes)
            }
            else if (msg.y == 'q' && msg.q == 'get_peers') {
                this.onGetPeersRequest(msg, rinfo)
            }
            else if (msg.y == 'q' && msg.q == 'announce_peer') {
                this.onAnnouncePeerRequest(msg, rinfo)
            }
        }
        catch (err) {
        }
    }

    start() {
        this.udp.bind(this.port, this.address)

        this.udp.on('listening', () => {
            console.log('UDP Server listening on %s:%s', this.address, this.port)
        })

        this.udp.on('message', (msg, rinfo) => {
            this.onMessage(msg, rinfo)
        })

        this.udp.on('error', () => {
            // do nothing
        })

        setInterval(() => {
            this.joinDHTNetwork()
            this.makeNeighbours()
        }, 1000)
    }
}

(new DHTSpider({address: '0.0.0.0', port: 6881})).start()
