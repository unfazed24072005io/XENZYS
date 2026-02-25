const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const multer = require('multer');

dotenv.config();

const app = express();

// ============ CONFIGURATION ============
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Create uploads directory
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`📁 Created upload directory: ${UPLOAD_DIR}`);
}

// ============ MIDDLEWARE ============
app.use(cors({
  origin: isProduction 
    ? ['https://your-frontend.netlify.app'] 
    : '*',
  credentials: true
}));
app.use(express.json());

// 1 HOUR TIMEOUTS
app.use((req, res, next) => {
  req.setTimeout(60 * 60 * 1000);
  res.setTimeout(60 * 60 * 1000);
  next();
});

// ============ MONGODB ============
const mongoURI = process.env.MONGODB_URI;
let db;

async function connectDB() {
  try {
    const client = new MongoClient(mongoURI);
    await client.connect();
    db = client.db('xenzys');
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB error:', error);
    process.exit(1);
  }
}
connectDB();

// ============ SIMPLE DISK STORAGE ============
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 1000 * 1024 * 1024 * 1024 } // 1000GB
});

// ============ UPLOAD ENDPOINT ============
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    const { title, type, username } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('\n=================================');
    console.log(`📤 FILE RECEIVED:`);
    console.log(`   Name: ${req.file.originalname}`);
    console.log(`   Saved as: ${req.file.filename}`);
    console.log(`   Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Path: ${req.file.path}`);
    console.log('=================================\n');

    // Save to database
    const video = {
      title: title || 'Untitled',
      filename: req.file.filename,
      type: type || 'long',
      size: req.file.size,
      username: username || 'Anonymous',
      views: 0,
      likes: 0,
      dislikes: 0,
      comments: [],
      createdAt: new Date(),
      path: req.file.path
    };

    const result = await db.collection('videos').insertOne(video);
    
    res.json({
      success: true,
      video: {
        _id: result.insertedId,
        ...video
      }
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ STREAM VIDEO FROM DISK ============
app.get('/api/video/:filename', async (req, res) => {
  try {
    const video = await db.collection('videos').findOne({ 
      filename: req.params.filename 
    });
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const filePath = path.join(UPLOAD_DIR, video.filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    // Update view count
    await db.collection('videos').updateOne(
      { _id: video._id },
      { $inc: { views: 1 } }
    );

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET VIDEOS ============
app.get('/api/videos/:type', async (req, res) => {
  try {
    const type = req.params.type;
    const videos = await db.collection('videos')
      .find({ type })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    
    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ INTERACTIONS ============
app.post('/api/video/:id/like', async (req, res) => {
  await db.collection('videos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $inc: { likes: 1 } }
  );
  res.json({ success: true });
});

app.post('/api/video/:id/dislike', async (req, res) => {
  await db.collection('videos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $inc: { dislikes: 1 } }
  );
  res.json({ success: true });
});

app.post('/api/video/:id/comment', async (req, res) => {
  const { username, text } = req.body;
  await db.collection('videos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { comments: { username, text, createdAt: new Date() } } }
  );
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📁 Videos saved to: ${UPLOAD_DIR}`);
  console.log(`⚠️  Make sure this drive has enough space!`);
});