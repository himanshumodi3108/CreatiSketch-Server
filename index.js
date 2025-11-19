require('dotenv').config();
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://creati-sketch.vercel.app' 
    : 'http://localhost:3000');

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { 
  cors: { 
    origin: CLIENT_URL,
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Rate limiting per socket
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 100; // max events per window

const checkRateLimit = (socketId) => {
  const now = Date.now();
  const userLimit = rateLimitMap.get(socketId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  if (now > userLimit.resetTime) {
    userLimit.count = 0;
    userLimit.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  if (userLimit.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  userLimit.count++;
  rateLimitMap.set(socketId, userLimit);
  return true;
};

// Input validation helpers
const validateCoordinates = (x, y, canvasWidth = 10000, canvasHeight = 10000) => {
  return (
    typeof x === 'number' && 
    typeof y === 'number' &&
    !isNaN(x) && 
    !isNaN(y) &&
    x >= -canvasWidth && x <= canvasWidth * 2 &&
    y >= -canvasHeight && y <= canvasHeight * 2
  );
};

const validateColor = (color) => {
  if (typeof color !== 'string') return false;
  // Accept hex colors (#RRGGBB), named colors, or any valid CSS color
  return /^#[0-9A-Fa-f]{3,6}$|^[a-zA-Z]+$|^rgba?\(/.test(color) && color.length <= 50;
};

const validateSize = (size) => {
  return typeof size === 'number' && size > 0 && size <= 100;
};

// Room management
const rooms = new Map(); // Stores room users: roomId -> Set<socketId>

const joinRoom = (socket, roomId = 'default') => {
  const previousRoomId = socket.roomId;
  const previousDisplayRoomId = socket.displayRoomId || previousRoomId;
  
  // Leave previous room if different (compare display room IDs)
  if (previousRoomId && previousDisplayRoomId !== roomId) {
    if (rooms.has(previousRoomId)) {
      rooms.get(previousRoomId).delete(socket.id);
      const prevUserCount = rooms.get(previousRoomId).size;
      if (prevUserCount === 0) {
        rooms.delete(previousRoomId);
      } else {
        // Only notify if leaving a collaborative room
        if (previousRoomId !== 'default' && !previousRoomId.startsWith('default_')) {
          socket.to(previousRoomId).emit('userLeft', { userCount: prevUserCount });
        }
      }
    }
  }
  
  socket.leaveAll();
  
  // For default room, create a unique room ID for each user to ensure complete isolation
  let actualRoomId = roomId;
  if (roomId === 'default') {
    actualRoomId = `default_${socket.id}`; // Unique room per user
  }
  
  socket.join(actualRoomId);
  socket.roomId = actualRoomId; // Store the actual room ID (unique for default)
  socket.displayRoomId = roomId; // Store the display room ID ('default' for UI)
  
  // Initialize room if it doesn't exist
  if (!rooms.has(actualRoomId)) {
    rooms.set(actualRoomId, new Set());
  }
  
  // Add socket to room (only if not already in it)
  if (!rooms.get(actualRoomId).has(socket.id)) {
    rooms.get(actualRoomId).add(socket.id);
  }
  
  const userCount = roomId === 'default' ? 1 : rooms.get(actualRoomId).size; // Default room always shows 1 user
  
  // Send display room ID to client (so UI shows 'default' not 'default_socketId')
  socket.emit('roomJoined', { roomId: roomId, userCount });
  
  // Default room is private - don't notify other users when someone joins/leaves
  if (roomId !== 'default') {
    socket.to(actualRoomId).emit('userJoined', { userCount });
  }
  
  console.log(`Socket ${socket.id} joined room ${actualRoomId} (display: ${roomId}, ${userCount} users). Total rooms: ${rooms.size}`);
  
  return actualRoomId;
};

const leaveRoom = (socket) => {
  if (socket.roomId && rooms.has(socket.roomId)) {
    rooms.get(socket.roomId).delete(socket.id);
    const userCount = rooms.get(socket.roomId).size;
    
    if (userCount === 0) {
      rooms.delete(socket.roomId);
      // Clean up password when room is empty (optional - you may want to keep it)
      // roomPasswords.delete(socket.roomId);
    } else {
      // Default room is private - don't notify other users when someone leaves
      // Check both 'default' and 'default_*' patterns
      if (socket.roomId !== 'default' && !socket.roomId.startsWith('default_')) {
        socket.to(socket.roomId).emit('userLeft', { userCount });
      }
    }
  }
};

io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Initialize default room if it doesn't exist
    if (!rooms.has('default')) {
      rooms.set('default', new Set());
    }
    
    // Join default room (no password needed for default room)
    joinRoom(socket, 'default');
    
    // Rate limit check wrapper
    const withRateLimit = (eventName, handler) => {
      return (data) => {
        if (!checkRateLimit(socket.id)) {
          socket.emit('error', { message: 'Rate limit exceeded. Please slow down.' });
          return;
        }
        handler(data);
      };
    };

    // Begin path event
    socket.on('beginPath', withRateLimit('beginPath', (data) => {
      try {
        if (!data || !validateCoordinates(data.x, data.y)) {
          return;
        }
        
        // Default room is private - no remote access/collaboration
        // Check both 'default' and 'default_*' patterns (unique rooms)
        if (socket.roomId === 'default' || (socket.roomId && socket.roomId.startsWith('default_'))) {
          return;
        }
        
        const pathData = {
          x: data.x,
          y: data.y,
          tool: data.tool || 'PENCIL'
        };
        
        // Always include color and size if provided (don't validate too strictly)
        if (data.color !== undefined && data.color !== null) {
          // Validate but be lenient - accept any string that looks like a color
          if (typeof data.color === 'string' && data.color.length > 0 && data.color.length <= 50) {
            pathData.color = data.color;
          }
        }
        if (data.size !== undefined && data.size !== null && validateSize(data.size)) {
          pathData.size = data.size;
        }
        
        socket.to(socket.roomId).emit('beginPath', pathData);
      } catch (error) {
        console.error('Error in beginPath:', error);
      }
    }));

    // Draw line event
    socket.on('drawLine', withRateLimit('drawLine', (data) => {
      try {
        if (!data || !validateCoordinates(data.x, data.y)) {
          return;
        }
        
        // Default room is private - no remote access/collaboration
        // Check both 'default' and 'default_*' patterns (unique rooms)
        if (socket.roomId === 'default' || (socket.roomId && socket.roomId.startsWith('default_'))) {
          return;
        }
        
        socket.to(socket.roomId).emit('drawLine', {
          x: data.x,
          y: data.y
        });
      } catch (error) {
        console.error('Error in drawLine:', error);
      }
    }));

    // Change config event
    socket.on('changeConfig', withRateLimit('changeConfig', (data) => {
      try {
        if (!data) return;
        
        // Default room is private - no remote access/collaboration
        // Check both 'default' and 'default_*' patterns (unique rooms)
        if (socket.roomId === 'default' || (socket.roomId && socket.roomId.startsWith('default_'))) {
          return;
        }
        
        const config = {
          color: validateColor(data.color) ? data.color : 'black',
          size: validateSize(data.size) ? data.size : 3
        };
        
        socket.to(socket.roomId).emit('changeConfig', config);
      } catch (error) {
        console.error('Error in changeConfig:', error);
      }
    }));

    // Draw shape event
    socket.on('drawShape', withRateLimit('drawShape', (data) => {
      try {
        if (!data || !data.type) return;
        
        // Default room is private - no remote access/collaboration
        // Check both 'default' and 'default_*' patterns (unique rooms)
        if (socket.roomId === 'default' || (socket.roomId && socket.roomId.startsWith('default_'))) {
          return;
        }
        
        const validTypes = ['rectangle', 'circle', 'line'];
        if (!validTypes.includes(data.type)) return;
        
        if (!validateCoordinates(data.startX, data.startY) || 
            !validateCoordinates(data.endX, data.endY)) {
          return;
        }
        
        const shapeData = {
          type: data.type,
          startX: data.startX,
          startY: data.startY,
          endX: data.endX,
          endY: data.endY,
          color: validateColor(data.color) ? data.color : 'black',
          size: validateSize(data.size) ? data.size : 3
        };
        
        socket.to(socket.roomId).emit('drawShape', shapeData);
      } catch (error) {
        console.error('Error in drawShape:', error);
      }
    }));

    // Clear canvas event
    socket.on('clearCanvas', withRateLimit('clearCanvas', () => {
      try {
        // Default room is private - no remote access/collaboration
        // Check both 'default' and 'default_*' patterns (unique rooms)
        if (socket.roomId === 'default' || (socket.roomId && socket.roomId.startsWith('default_'))) {
          return;
        }
        
        socket.to(socket.roomId).emit('clearCanvas');
      } catch (error) {
        console.error('Error in clearCanvas:', error);
      }
    }));

    // Join room event
    socket.on('joinRoom', withRateLimit('joinRoom', (data) => {
      try {
        const roomId = data?.roomId || 'default';
        const createIfNotExists = data?.create === true;
        
        // Sanitize room ID (alphanumeric and hyphens only, max 50 chars)
        const sanitizedRoomId = String(roomId).replace(/[^a-zA-Z0-9-]/g, '').substring(0, 50) || 'default';
        
        // Check if room exists (unless creating new room)
        if (!createIfNotExists && sanitizedRoomId !== 'default' && !rooms.has(sanitizedRoomId)) {
          socket.emit('roomError', { 
            message: `Room "${sanitizedRoomId}" does not exist. Use "Create New Room" to create it.` 
          });
          return;
        }
        
        // Leave current room before joining new one
        // Compare display room IDs (not actual room IDs) to handle default room correctly
        const currentDisplayRoom = socket.displayRoomId || socket.roomId;
        if (currentDisplayRoom && currentDisplayRoom !== sanitizedRoomId) {
          leaveRoom(socket);
        }
        
        joinRoom(socket, sanitizedRoomId);
      } catch (error) {
        console.error('Error in joinRoom:', error);
        socket.emit('roomError', { message: 'Failed to join room' });
      }
    }));

    // Leave room event
    socket.on('leaveRoom', () => {
      try {
        if (socket.roomId) {
          leaveRoom(socket);
          // Join default room after leaving
          joinRoom(socket, 'default');
        }
      } catch (error) {
        console.error('Error in leaveRoom:', error);
        socket.emit('roomError', { message: 'Failed to leave room' });
      }
    });

    // Get available rooms
    socket.on('getRooms', () => {
      try {
        // Get all rooms with users, EXCLUDING default room (it's private)
        const availableRooms = Array.from(rooms.keys())
          .filter(roomId => {
            // Exclude default room and all default_* rooms from public room list
            if (roomId === 'default' || roomId.startsWith('default_')) return false;
            const room = rooms.get(roomId);
            return room && room.size > 0;
          })
          .map(roomId => ({
            id: roomId,
            userCount: rooms.get(roomId).size
          }));
        
        // Sort alphabetically (default room is not shown)
        availableRooms.sort((a, b) => a.id.localeCompare(b.id));
        
        socket.emit('roomsList', { rooms: availableRooms });
      } catch (error) {
        console.error('Error in getRooms:', error);
        socket.emit('roomsList', { rooms: [] });
      }
    });

    // Disconnect handler
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      leaveRoom(socket);
      rateLimitMap.delete(socket.id);
    });

    // Error handler
    socket.on('error', (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    totalConnections: io.sockets.sockets.size
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS enabled for: ${CLIENT_URL}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`Please either:`);
    console.error(`  1. Stop the process using port ${PORT}`);
    console.error(`  2. Change the PORT in your .env file`);
    console.error(`\nTo find and kill the process:`);
    console.error(`  Windows: netstat -ano | findstr :${PORT}`);
    console.error(`  Then: taskkill /PID <PID> /F`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
