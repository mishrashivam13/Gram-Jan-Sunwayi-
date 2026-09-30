const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'sarpanch-super-secret-key';

// Setup Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Serve uploads statically so frontend can access the audio/images
app.use('/uploads', express.static(uploadDir));

// Setup Multer Storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || (file.mimetype.includes('webm') ? '.webm' : '');
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage });

// Database Connection
let db;
async function initializeDB() {
  db = await open({
    filename: path.join(__dirname, 'database.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT 'अन्य',
      problem_text TEXT,
      audio_url TEXT,
      media_urls TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await db.exec(`ALTER TABLE complaints ADD COLUMN category TEXT DEFAULT 'अन्य'`);
  } catch (err) {
    // Column probably already exists
  }
  console.log('Database initialized.');
}
initializeDB();

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};


// --- API ROUTES ---

// 1. Admin Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Hardcoded credentials for MVP
  if (username === 'sarpanch' && password === '12345') {
    const token = jwt.sign({ username: 'sarpanch', role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token });
  } else {
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
  }
});

// 2. Submit a new complaint (Public)
app.post('/api/complaints', upload.fields([
  { name: 'audio', maxCount: 1 }, 
  { name: 'media', maxCount: 5 }
]), async (req, res) => {
  try {
    const problemText = req.body.problem || '';
    const categoryText = req.body.category || 'अन्य';
    
    let audioUrl = null;
    if (req.files['audio'] && req.files['audio'].length > 0) {
      audioUrl = `${req.protocol}://${req.get('host')}/uploads/${req.files['audio'][0].filename}`;
    }

    let mediaUrls = [];
    if (req.files['media'] && req.files['media'].length > 0) {
      mediaUrls = req.files['media'].map(f => `${req.protocol}://${req.get('host')}/uploads/${f.filename}`);
    }

    const result = await db.run(
      'INSERT INTO complaints (category, problem_text, audio_url, media_urls) VALUES (?, ?, ?, ?)',
      [categoryText, problemText, audioUrl, JSON.stringify(mediaUrls)]
    );

    res.status(201).json({
      success: true,
      message: 'Complaint submitted successfully',
      complaintId: result.lastID
    });
  } catch (error) {
    console.error('Error submitting complaint:', error);
    res.status(500).json({ success: false, error: 'Failed to submit complaint' });
  }
});

// 3. Fetch all complaints (Protected)
app.get('/api/complaints', authenticateToken, async (req, res) => {
  try {
    const complaints = await db.all('SELECT * FROM complaints ORDER BY created_at DESC');
    const parsedComplaints = complaints.map(c => ({
      ...c,
      media_urls: c.media_urls ? JSON.parse(c.media_urls) : []
    }));
    res.json(parsedComplaints);
  } catch (error) {
    console.error('Error fetching complaints:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch complaints' });
  }
});

// 4. Fetch a specific complaint's status (Public)
app.get('/api/complaints/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const complaint = await db.get('SELECT id, status FROM complaints WHERE id = ?', [id]);
    if (complaint) {
      res.json({ success: true, status: complaint.status });
    } else {
      res.status(404).json({ success: false, error: 'Complaint not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch status' });
  }
});

// 5. Update complaint status (Protected)
app.patch('/api/complaints/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    await db.run('UPDATE complaints SET status = ? WHERE id = ?', [status, id]);
    res.json({ success: true, message: 'Status updated successfully' });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// 5. Delete a complaint (Protected)
app.delete('/api/complaints/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch complaint to get file URLs so we can delete them from disk
    const complaint = await db.get('SELECT audio_url, media_urls FROM complaints WHERE id = ?', [id]);
    
    if (complaint) {
      // Delete audio file
      if (complaint.audio_url) {
        const filename = complaint.audio_url.split('/').pop();
        const filepath = path.join(uploadDir, filename);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      }
      
      // Delete media files
      if (complaint.media_urls) {
        const mediaUrls = JSON.parse(complaint.media_urls);
        mediaUrls.forEach(url => {
          const filename = url.split('/').pop();
          const filepath = path.join(uploadDir, filename);
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        });
      }
    }

    // Delete from database
    await db.run('DELETE FROM complaints WHERE id = ?', [id]);
    res.json({ success: true, message: 'Complaint deleted successfully' });
  } catch (error) {
    console.error('Error deleting complaint:', error);
    res.status(500).json({ success: false, error: 'Failed to delete complaint' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
