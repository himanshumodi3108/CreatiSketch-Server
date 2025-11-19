# CreatiSketch Server

Socket.io server for real-time collaborative drawing application. Handles real-time drawing synchronization, room management, and user coordination.

## Features

- **Real-time Drawing Synchronization** - Broadcasts drawing events to all users in a collaborative room
- **Room-based Collaboration** - Multiple rooms for different drawing sessions
- **Private Default Room** - Each user gets an isolated workspace by default (no remote access)
- **Rate Limiting** - 100 events per second per user to prevent abuse
- **Input Validation** - Validates all coordinates, colors, and sizes
- **Room ID Sanitization** - Prevents injection attacks
- **CORS Support** - Configurable CORS for security
- **Health Check Endpoint** - Monitor server status
- **Room Management** - Create, join, and leave rooms with user count tracking

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```env
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000
```

3. Start the server:
```bash
npm start
# or
npm run dev
```

The server will start on port 5000 (or the port specified in `.env`).

## Environment Variables

- `PORT` - Server port (default: 5000)
- `NODE_ENV` - Environment mode (development/production)
- `CLIENT_URL` - Allowed CORS origin URL

## API Endpoints

### Health Check
- `GET /health` - Returns server status, active rooms count, and total connections

Example response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "activeRooms": 5,
  "totalConnections": 12
}
```

## Socket Events

### Client → Server

#### Drawing Events
- `beginPath` - Start a new drawing path
  ```javascript
  { x: number, y: number, color?: string, size?: number, tool?: string }
  ```
- `drawLine` - Draw a line segment
  ```javascript
  { x: number, y: number }
  ```
- `drawShape` - Draw a shape (rectangle, circle, line)
  ```javascript
  { 
    type: 'rectangle' | 'circle' | 'line',
    startX: number, startY: number,
    endX: number, endY: number,
    color: string, size: number
  }
  ```
- `changeConfig` - Change drawing configuration (color, size)
  ```javascript
  { color: string, size: number }
  ```
- `clearCanvas` - Clear the canvas

#### Room Management
- `joinRoom` - Join or create a room
  ```javascript
  { roomId: string, create?: boolean }
  ```
  - If `create: true`, creates a new room if it doesn't exist
  - If `create: false` (default), only joins existing rooms
  - Returns error if room doesn't exist and `create` is false
- `leaveRoom` - Leave current room (returns to default room)
- `getRooms` - Get list of available collaborative rooms (excludes default/private rooms)

### Server → Client

#### Drawing Events
- `beginPath` - Remote user started drawing
- `drawLine` - Remote user drew a line
- `drawShape` - Remote user drew a shape
- `changeConfig` - Remote user changed config (not used in default room)
- `clearCanvas` - Canvas was cleared

#### Room Events
- `roomJoined` - Successfully joined a room
  ```javascript
  { roomId: string, userCount: number }
  ```
  - `roomId`: Display room ID (e.g., "default" or custom room name)
  - `userCount`: Number of users in the room (always 1 for default room)
- `userJoined` - Another user joined the room (only for collaborative rooms)
  ```javascript
  { userCount: number }
  ```
- `userLeft` - A user left the room (only for collaborative rooms)
  ```javascript
  { userCount: number }
  ```
- `roomsList` - List of available collaborative rooms
  ```javascript
  { rooms: Array<{ id: string, userCount: number }> }
  ```
  - Excludes default/private rooms from the list
- `roomError` - Error occurred (room doesn't exist, etc.)
  ```javascript
  { message: string }
  ```
- `error` - General error occurred

## Security Features

### Rate Limiting
- **100 events per second** per socket connection
- Prevents abuse and DoS attacks
- Returns error message if limit exceeded

### Input Validation
- **Coordinates**: Validated to be numbers within reasonable bounds
- **Colors**: Validated to be valid CSS color strings (max 50 chars)
- **Sizes**: Validated to be numbers between 1-100
- **Room IDs**: Sanitized to alphanumeric and hyphens only (max 50 chars)

### Room Isolation
- **Default Room**: Each user gets a unique Socket.IO room (`default_${socketId}`) for complete isolation
  - Display room ID is "default" for UI purposes
  - Actual Socket.IO room is unique per user
  - No drawing events are broadcasted to other users
  - User count always shows as 1
- **Collaborative Rooms**: Users share the same room for real-time collaboration
  - All drawing events are synchronized in real-time
  - User count is tracked and updated
  - Rooms are listed in the public room list
- **Room Privacy**: Default room events are never broadcasted to other users

### CORS Protection
- Only configured origins are allowed
- Prevents unauthorized access from other domains

## Error Handling

The server includes comprehensive error handling:
- **Port Conflict Detection** - Helpful error messages if port is in use
- **Socket Error Logging** - All socket errors are logged
- **Input Validation Errors** - Invalid inputs are silently rejected
- **Rate Limit Warnings** - Users are notified when rate limit is exceeded

## Room System

### Default Room (Private)
- Each user automatically joins a private default room on connection
- Each user gets a unique Socket.IO room ID: `default_${socketId}`
- Display room ID is "default" for UI consistency
- No events are broadcasted to other users
- Perfect for solo work without any remote interference

### Collaborative Rooms
- Users can create or join rooms with custom names
- All drawing events (beginPath, drawLine, drawShape, clearCanvas) are synchronized in real-time
- User count is tracked and displayed
- Rooms are listed in the room manager (default rooms are excluded)
- Room names are sanitized (alphanumeric and hyphens only, max 50 chars)

## Development

### Project Structure
```
creatisketch-server/
├── index.js          # Main server file
├── package.json      # Dependencies
└── .env             # Environment variables (not in git)
```

### Dependencies
- `express` - Web server framework
- `socket.io` - Real-time communication
- `cors` - CORS middleware
- `dotenv` - Environment variable management

## License

ISC
