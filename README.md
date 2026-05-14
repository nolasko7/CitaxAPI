# Citax API

API backend de Citax para gestion de empresas, profesionales, clientes, turnos, disponibilidad, recordatorios, landing publica y flujos de WhatsApp con Evolution API.

## Stack actual

- Node.js + Express 5
- MySQL (`mysql2/promise`)
- Prisma Client + schema Prisma
- JWT para auth de empresa y prestador
- Evolution API para WhatsApp
- Gemini / Groq / Ollama / OpenRouter para flujos AI
- `pino` + `pino-http` para logging

## Modulos principales

- Auth multirol: `admin_empresa`, `prestador`
- Turnos manuales y desde landing publica
- Disponibilidad general por empresa y por prestador
- Fechas bloqueadas
- Servicios y asignacion a prestadores
- Clientes y metricas basicas
- Notificaciones internas derivadas de turnos
- Recordatorios manuales y automaticos por WhatsApp
- Bot WhatsApp con `bot_config`
- Landing publica por subdominio `slug.citax.com.ar`
- Superadmin con WhatsApp de soporte

## Estructura

```text
CitaxAPI/
|-- prisma/
|   |-- schema.prisma
|   `-- migrations/
|-- src/
|   |-- app.js
|   |-- server.js
|   |-- config/
|   |-- controllers/
|   |-- middlewares/
|   |-- routes/
|   |-- services/
|   |   `-- ai/
|   `-- utils/
|-- test/
|-- .env.example
`-- package.json
```

## Requisitos

- Node.js 18+
- MySQL
- Evolution API accesible
- Variables de entorno configuradas

## Instalacion

```bash
npm install
Copy-Item .env.example .env
```

Completar `.env` y luego:

```bash
npx prisma generate
npx prisma migrate deploy
npm run dev
```

## Scripts

- `npm run dev`: levanta API con `src/server.js`
- `npm start`: mismo entrypoint de produccion
- `npm test`: corre `node test/all.test.js`

## Variables de entorno

Base:

- `PORT`
- `NODE_ENV`
- `APP_ENABLE_REMINDERS`

MySQL:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DATABASE_URL`

JWT:

- `JWT_SECRET`
- `JWT_EXPIRES_IN`

Evolution / WhatsApp:

- `EVOLUTION_API_URL`
- `EVOLUTION_API_KEY`
- `EVOLUTION_INSTANCE_NAME`
- `WHATSAPP_ASSISTANT_PERSONA`
- `WHATSAPP_AI_ENABLED`
- `WHATSAPP_DEFAULT_COMPANY_ID`
- `WHATSAPP_CONTROL_NUMBER`
- `WHATSAPP_NOTIFICATION_INSTANCE_NAME`
- `WHATSAPP_MESSAGE_BUFFER_MS`
- `EVOLUTION_WEBHOOK_ENABLED`
- `BACKEND_PUBLIC_URL`

LLM:

- `OLLAMA_API_KEY`
- `OLLAMA_API_URL`
- `OLLAMA_MODEL`
- `GOOGLE_API_KEY`
- `GEMINI_MODEL`
- `GROQ_API_KEY`
- `GROQ_MODEL`
- `OPENROUTER_API_KEY`
- `LLM_PRIMARY_PROVIDER`
- `LLM_PRIMARY_MODEL`
- `LLM_PRIMARY_LABEL`
- `LLM_FALLBACK_PROVIDER`
- `LLM_FALLBACK_MODEL`
- `LLM_FALLBACK_LABEL`

Superadmin:

- `SUPERADMIN_USER`
- `SUPERADMIN_PASS`
- `SUPERADMIN_SECRET`
- `SUPERADMIN_WA_INSTANCE`
- `SUPPORT_SESSION_TTL_HOURS`

Ver referencia completa en [.env.example](/C:/Users/nicot/Desktop/Citax/CitaxAPI/.env.example).

## Arranque y salud

- `GET /` -> estado basico
- `GET /health` -> estado, version y modelo activo

Si `APP_ENABLE_REMINDERS=true`, al iniciar tambien se levanta scheduler de recordatorios.

## Auth

Auth empresa/prestador usa Bearer token JWT.

Header:

```http
Authorization: Bearer <token>
```

Endpoints:

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/register`

`/login` devuelve `token` y `user` con:

- `id`
- `email`
- `rol`
- `empresa_id`
- `id_prestador`
- `nombre_comercial`
- `slug`

## Roles

- `admin_empresa`: gestion completa de empresa
- `prestador`: acceso acotado a su empresa y su disponibilidad
- `superadmin`: login separado en `/api/superadmin`

## Rutas actuales

### Auth

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/register`

### Appointments

- `GET /api/appointments`
- `POST /api/appointments`
- `PUT /api/appointments/:id`
- `DELETE /api/appointments/:id`

Notas:

- turnos manuales se crean `confirmado`
- turnos publicos se crean `pendiente_confirmacion`
- transiciones permitidas: `pendiente -> confirmado | cancelado`, `pendiente_confirmacion -> confirmado | cancelado`, `confirmado -> cancelado`

### Availability

- `GET /api/availability`
- `GET /api/availability/config`
- `PUT /api/availability/config`
- `GET /api/availability/blocked-dates`
- `POST /api/availability/blocked-dates`
- `DELETE /api/availability/blocked-dates/:fecha`

Notas:

- soporta `prestador_id` por query/body
- en modo `cuenta_prestador_unico` fuerza uso de config general de empresa

### Config

- `GET /api/config`
- `PUT /api/config`
- `GET /api/config/company-profile`
- `PUT /api/config/company-profile`
- `GET /api/config/account-profile`
- `PUT /api/config/account-profile`
- `GET /api/config/bot`
- `PUT /api/config/bot`

### Services

- `GET /api/services`
- `POST /api/services`
- `PATCH /api/services/:id`
- `DELETE /api/services/:id`

### Professionals

- `GET /api/professionals`
- `POST /api/professionals`
- `PATCH /api/professionals/:id`
- `DELETE /api/professionals/:id`
- `GET /api/professionals/:id/services`
- `POST /api/professionals/:id/services`
- `DELETE /api/professionals/:id/services/:serviceId`

### Clients

- `GET /api/clients`
- `PUT /api/clients/:id`
- `DELETE /api/clients/:id`

### Notifications

- `GET /api/notifications`
- `PATCH /api/notifications/read-all`

Tipos generados hoy:

- `booking_confirmed`
- `booking_cancelled`
- `manual_booking`
- `manual_confirmed_cancellation`

### Reminders

- `GET /api/reminders/today`
- `POST /api/reminders/send-today`

### WhatsApp empresa

- `POST /api/whatsapp/create-instance`
- `GET /api/whatsapp/status`
- `GET /api/whatsapp/messages`
- `POST /api/whatsapp/send-message`
- `POST /api/whatsapp/disconnect`
- `GET /api/whatsapp/bot-status`
- `PUT /api/whatsapp/bot-status`
- `POST /api/whatsapp/webhook/:instanceName` publico

Ademas `app.js` expone webhook server-to-server:

- `POST /api/webhook`
- `POST /api/whatsapp/webhook/:instanceName`

### Public landing

- `GET /api/public/landing/:slug`
- `GET /api/public/landing/:slug/availability`
- `POST /api/public/landing/:slug/appointments`

Flujo:

- busca empresa por `slug`
- devuelve landing template, servicios y profesionales
- valida disponibilidad real antes de crear turno
- crea turno en estado `pendiente_confirmacion`
- intenta notificar por WhatsApp al numero de empresa

### Superadmin

- `POST /api/superadmin/login`
- `GET /api/superadmin/support-whatsapp/status`
- `POST /api/superadmin/support-whatsapp/connect`
- `POST /api/superadmin/support-whatsapp/disconnect`

## Modelo de datos

Tablas/modelos principales:

- `USUARIO`
- `EMPRESA`
- `PRESTADOR`
- `SERVICIO`
- `PRESTADOR_SERVICIO`
- `CLIENTE`
- `TURNO`
- `TURNO_RECORDATORIO`
- `CONFIG_WHATSAPP`
- `MENSAJE_CONVERSACION`
- `BLOCKED_DATES`

Campos funcionales clave:

- `EMPRESA.slug`: subdominio publico
- `EMPRESA.horarios_disponibilidad`: JSON de agenda general
- `EMPRESA.config_recordatorios`: JSON de recordatorios
- `EMPRESA.bot_config`: JSON de bot/landing/modo prestador unico
- `PRESTADOR.horarios_disponibilidad`: override por prestador
- `TURNO.estado`: `pendiente`, `pendiente_confirmacion`, `confirmado`, `cancelado`
- `TURNO.origen`: canal de origen, ej `manual`, `pagina`

Schema completo: [prisma/schema.prisma](/C:/Users/nicot/Desktop/Citax/CitaxAPI/prisma/schema.prisma)

## Modos especiales

### Cuenta prestador unico

Se maneja desde `bot_config.cuenta_prestador_unico`.

Efectos:

- no permite crear mas prestadores
- servicios se vinculan automaticamente
- disponibilidad opera sobre empresa como fuente unica

### Landing publica

Se arma desde `bot_config` + `slug` de empresa. URL esperada:

```text
https://<slug>.citax.com.ar
```

## CORS

Permitidos hoy:

- `https://www.citax.com.ar`
- `https://citax.com.ar`
- `http://localhost:5173`
- `http://localhost:5174`
- `http://localhost:3000`
- subdominios `*.citax.com.ar`
- hosts locales `*.localhost` y `*.citax.local`

Webhooks bypass CORS por ser server-to-server.

## Tests

Suite actual en `test/` cubre, entre otros:

- prompts y contexto AI
- disponibilidad
- auth superadmin
- Evolution services
- notificaciones
- transiciones de estado de turnos
- modo prestador unico

Ejecutar:

```bash
npm test
```

## Archivos clave

- [src/app.js](/C:/Users/nicot/Desktop/Citax/CitaxAPI/src/app.js)
- [src/server.js](/C:/Users/nicot/Desktop/Citax/CitaxAPI/src/server.js)
- [src/routes](/C:/Users/nicot/Desktop/Citax/CitaxAPI/src/routes)
- [src/services](/C:/Users/nicot/Desktop/Citax/CitaxAPI/src/services)
- [prisma/schema.prisma](/C:/Users/nicot/Desktop/Citax/CitaxAPI/prisma/schema.prisma)

## Nota operativa

README describe estructura actual observada en codigo hoy. Si cambiamos rutas, env o shape de `bot_config`, conviene mantener este archivo junto con cada cambio para que no vuelva a quedar como placeholder.
