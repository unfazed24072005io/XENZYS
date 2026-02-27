const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

// Create directories if they don't exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Cloudinary Configuration
cloudinary.config({
  cloud_name: 'doi8vbjji',
  api_key: '454572477742312',
  api_secret: 'CT1dolCMyCv7R0Tcms94biI-zH4'
});

console.log('✅ Cloudinary Configured');

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  });

// Updated Video Schema (with more fields)
const videoSchema = new mongoose.Schema({
  fileName: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: function() {
      return this.fileName.replace(/\.[^/.]+$/, "");
    }
  },
  description: {
    type: String,
    default: ""
  },
  username: {
    type: String,
    default: "anonymous"
  },
  cloudinaryUrl: {
    type: String,
    required: true
  },
  publicId: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  uploadDate: {
    type: Date,
    default: Date.now
  },
  format: String,
  duration: Number,
  category: {
    type: String,
    default: "all"
  },
  tags: [String],
  views: {
    type: Number,
    default: 0
  }
});

const Video = mongoose.model('Video', videoSchema);

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',           // React dev server
    'http://localhost:3001',           // React dev server (alternate)
    'https://xenzys.onrender.com',     // Your deployed backend
    'capacitor://localhost',            // ⬅️ Capacitor iOS
    'http://localhost',                  // ⬅️ Capacitor Android (HTTP)
    'http://192.168.%',                   // ⬅️ Your local network IPs
    'file://'                             // ⬅️ Some Capacitor setups
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files locally (as backup)
app.use('/uploads', express.static(UPLOAD_DIR));

// Get all videos from MongoDB
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await Video.find().sort({ uploadDate: -1 });
    res.json({ success: true, videos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single video by ID
app.get('/api/videos/:id', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    res.json({ success: true, video });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload chunk endpoint
app.post('/api/upload-chunk', (req, res) => {
  const { fileName, chunkIndex } = req.query;

  if (!fileName || chunkIndex === undefined) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const chunkPath = path.join(TEMP_DIR, `${fileName}.${chunkIndex}`);
  const writeStream = fs.createWriteStream(chunkPath);

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    res.json({ success: true });
  });

  writeStream.on('error', () => {
    res.status(500).json({ error: 'Chunk write failed' });
  });
});

// Merge chunks and upload to Cloudinary
app.post('/api/merge-chunks', async (req, res) => {
  const { fileName, totalChunks, videoDetails } = req.body;

  if (!fileName || !totalChunks) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    console.log(`🔄 Merging ${totalChunks} chunks for ${fileName}`);
    
    const finalPath = path.join(UPLOAD_DIR, fileName);
    const writeStream = fs.createWriteStream(finalPath);

    // Calculate total file size
    let totalSize = 0;

    // Merge all chunks
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(TEMP_DIR, `${fileName}.${i}`);

      if (!fs.existsSync(chunkPath)) {
        writeStream.end();
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }

      const stats = fs.statSync(chunkPath);
      totalSize += stats.size;

      const chunk = fs.readFileSync(chunkPath);
      writeStream.write(chunk);
      
      fs.unlinkSync(chunkPath);
    }

    // Finish writing the merged file
    writeStream.end();

    writeStream.on('finish', async () => {
      try {
        console.log(`📤 Uploading ${fileName} to Cloudinary...`);
        
        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(finalPath, {
          resource_type: 'video',
          folder: 'video_uploads',
          public_id: fileName.split('.')[0],
          eager: [
            { width: 300, height: 300, crop: "pad" }
          ]
        });

        console.log('✅ Uploaded to Cloudinary:', result.secure_url);

        // Prepare video details from frontend or use defaults
        const details = videoDetails || {};
        
        // Save metadata to MongoDB with all fields
        const video = new Video({
          fileName: fileName,
          title: details.title || fileName.replace(/\.[^/.]+$/, ""),
          description: details.description || "",
          username: details.username || "anonymous",
          cloudinaryUrl: result.secure_url,
          publicId: result.public_id,
          fileSize: result.bytes || totalSize,
          format: result.format,
          duration: result.duration,
          category: details.category || "all",
          tags: details.tags || []
        });

        await video.save();
        console.log('✅ Video metadata saved to MongoDB');
        console.log('📋 Video details:', {
          title: video.title,
          description: video.description,
          username: video.username,
          category: video.category
        });

        res.json({ 
          success: true,
          message: 'Upload complete',
          video: {
            _id: video._id,
            fileName: video.fileName,
            title: video.title,
            description: video.description,
            username: video.username,
            url: video.cloudinaryUrl,
            fileSize: video.fileSize,
            uploadDate: video.uploadDate,
            category: video.category,
            tags: video.tags
          }
        });

      } catch (cloudinaryError) {
        console.error('❌ Cloudinary upload error:', cloudinaryError);
        res.status(500).json({ 
          success: false, 
          error: 'Failed to upload to Cloudinary',
          details: cloudinaryError.message 
        });
      }
    });

    writeStream.on('error', (error) => {
      console.error('❌ Write stream error:', error);
      res.status(500).json({ error: 'Failed to merge chunks' });
    });

  } catch (error) {
    console.error('❌ Merge error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update video views
app.post('/api/videos/:id/view', async (req, res) => {
  try {
    const video = await Video.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    );
    res.json({ success: true, views: video.views });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test route
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running',
    cloudinary: 'Configured',
    mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
  });
});

app.listen(PORT, () => {
  console.log('🚀 Server running on port', PORT);
  console.log('📁 Upload directory:', UPLOAD_DIR);
  console.log('📁 Temp directory:', TEMP_DIR);
  console.log('☁️  Cloudinary configured with cloud:', 'doi8vbjji');
});
