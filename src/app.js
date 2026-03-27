const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth.routes');
const appointmentsRoutes = require('./routes/appointments.routes');
const availabilityRoutes = require('./routes/availability.routes');
const configRoutes = require('./routes/config.routes');
const servicesRoutes = require('./routes/services.routes');
const professionalsRoutes = require('./routes/professionals.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');

const app = express();

const corsOptions = {
    origin: [
        'https://www.citax.com.ar',
        'https://citax.com.ar',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/config', configRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/professionals', professionalsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.post('/api/webhook', require('./controllers/whatsapp.controller').handleWebhook);

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
