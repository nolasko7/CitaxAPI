const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth.routes");
const appointmentsRoutes = require("./routes/appointments.routes");
const availabilityRoutes = require("./routes/availability.routes");
const configRoutes = require("./routes/config.routes");
const servicesRoutes = require("./routes/services.routes");
const professionalsRoutes = require("./routes/professionals.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");
const superadminRoutes = require("./routes/superadmin.routes");
const publicRoutes = require("./routes/public.routes");

const app = express();
const fs = require("fs");
const path = require("path");

// Simple request logger for diagnosis
app.use((req, res, next) => {
  const log = `📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url} - Origin: ${req.get("origin") || "direct"}\n`;
  console.log(log.trim());
  try {
    fs.appendFileSync(path.join(__dirname, "../debug_out.txt"), log);
  } catch (e) {}
  next();
});

const allowedOrigins = new Set([
  "https://www.citax.com.ar",
  "https://citax.com.ar",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
]);

const isAllowedCitaxOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.citax\.com\.ar$/i.test(origin)) return true;
  if (/^http:\/\/localhost:\d+$/i.test(origin)) return true;
  if (/^http:\/\/[a-z0-9-]+\.localhost:\d+$/i.test(origin)) return true;
  if (/^http:\/\/[a-z0-9-]+\.citax\.local:\d+$/i.test(origin)) return true;
  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedCitaxOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin no permitido por CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "ngrok-skip-browser-warning",
  ],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// Main check and Health
app.get("/", (req, res) =>
  res.json({ message: "Citax API is running", version: "1.0.0" }),
);
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    version: process.env.APP_VERSION || "local",
    model: process.env.GEMINI_MODEL || "not set",
  }),
);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/appointments", appointmentsRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/config", configRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/professionals", professionalsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/superadmin", superadminRoutes);
app.use("/api/public", publicRoutes);
app.post(
  "/api/webhook",
  require("./controllers/whatsapp.controller").handleWebhook,
);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

module.exports = app;
