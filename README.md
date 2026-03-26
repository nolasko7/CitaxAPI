# Citax API

Nueva API del sistema Citax, a construir desde cero.

## Stack sugerido

- **Runtime**: Node.js
- **Framework**: Express / Fastify
- **ORM**: Prisma
- **Base de datos**: PostgreSQL
- **Auth**: JWT

## Endpoints a implementar

### Autenticación
- `POST /auth/login`
- `POST /auth/register`

### Turnos (Appointments)
- `GET /appointments` — listar turnos del mes
- `POST /appointments` — crear turno
- `PUT /appointments/:id` — actualizar turno (ej: confirmar)
- `DELETE /appointments/:id` — cancelar turno

### Disponibilidad
- `GET /availability` — consultar slots disponibles
- `GET /availability/config/:id` — obtener config de disponibilidad
- `PUT /availability/config/:id` — actualizar config

### Servicios y Profesionales
- `GET /services` — listar servicios
- `GET /professionals` — listar profesionales

### Configuración
- `GET /config` — configuración de empresa
- `PUT /config` — actualizar configuración

### WhatsApp
- `GET /whatsapp/instances/current` — instancia activa
- `POST /whatsapp/instances/create-qr` — generar QR
- `GET /whatsapp/instances/:name/status` — estado de instancia
- `GET /whatsapp/instances/:name/messages` — mensajes recibidos
- `GET /whatsapp/instances/:name/groups` — grupos
- `DELETE /whatsapp/instances/current` — desconectar
- `GET /whatsapp/blacklist` — lista negra
- `POST /whatsapp/blacklist` — agregar a lista negra
- `DELETE /whatsapp/blacklist/:phone` — quitar de lista negra

## Citax API