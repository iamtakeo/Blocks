export default class BlocksServer {
  constructor(room) {
    this.room = room;
    this.players = new Map(); // Store connected player data: id -> { id, username, color, position, rotation }
  }

  async onConnect(connection, ctx) {
    console.log(`Connection opened: ${connection.id}`);
    
    // Parse query params to get player details
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username") || `Player_${connection.id.slice(0, 4)}`;
    const color = url.searchParams.get("color") || "#3b82f6"; // Default blue

    // Register new player
    const newPlayer = {
      id: connection.id,
      username,
      color,
      position: { x: 0, y: 1.5, z: 0 },
      rotation: { y: 0 }
    };
    this.players.set(connection.id, newPlayer);

    // Retrieve persistent world state
    let blocks = await this.room.storage.get("blocks") || {};

    // 1. Send initial state to the connected player
    connection.send(JSON.stringify({
      type: "init",
      id: connection.id,
      players: Array.from(this.players.values()),
      blocks: blocks
    }));

    // 2. Broadcast the arrival of this new player to all others
    this.room.broadcast(
      JSON.stringify({
        type: "player-joined",
        player: newPlayer
      }),
      [connection.id] // exclude the joining player
    );
  }

  async onMessage(message, sender) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case "player-update": {
          const player = this.players.get(sender.id);
          if (player) {
            player.position = data.position;
            player.rotation = data.rotation;
            
            // Broadcast new position to everyone else
            this.room.broadcast(
              JSON.stringify({
                type: "player-update",
                id: sender.id,
                position: data.position,
                rotation: data.rotation
              }),
              [sender.id]
            );
          }
          break;
        }

        case "block-change": {
          const { key, block } = data.change; // key: "x,y,z", block: { type, color } | null
          
          // Load blocks, apply change, and save back
          let blocks = await this.room.storage.get("blocks") || {};
          if (block === null) {
            delete blocks[key];
          } else {
            blocks[key] = block;
          }
          await this.room.storage.put("blocks", blocks);

          // Broadcast the block change to everyone in the room
          this.room.broadcast(JSON.stringify({
            type: "block-change",
            key,
            block
          }));
          break;
        }

        case "chat-message": {
          const player = this.players.get(sender.id);
          if (player) {
            this.room.broadcast(JSON.stringify({
              type: "chat-message",
              username: player.username,
              color: player.color,
              message: data.message
            }));
          }
          break;
        }
      }
    } catch (err) {
      console.error("Error processing message:", err);
    }
  }

  async onClose(connection) {
    console.log(`Connection closed: ${connection.id}`);
    
    // Remove the player
    this.players.delete(connection.id);

    // Broadcast departure to everyone else
    this.room.broadcast(JSON.stringify({
      type: "player-left",
      id: connection.id
    }));
  }
}
