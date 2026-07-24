---
tags: [roadmap, next-steps]
created: 2026-06-12
updated: 2026-06-12
---

# Next Steps

## Prioridad Alta

### 1. Persistencia de Sesiones
- Base de datos (SQLite o PostgreSQL)
- Guardar conversaciones, tareas, agentes
- Historial consultable

### 2. Framework Agentic
- Integrar MCP (Model Context Protocol)
- Tool use: agentes pueden ejecutar acciones reales
- Conectar a bases de datos, APIs externas

### 3. Autenticación
- Login de usuarios
- Sesiones por usuario
- Permisos de acceso

## Prioridad Media

### 4. Tests
- Tests unitarios para lógica de routing
- Tests de integración para WebSocket
- Tests de telemetría

### 5. Rate Limiting
- Limitar turnos por usuario
- Limitar llamadas a API por sesión
- Protección contra abuso

### 6. Monitoring
- Métricas de performance en producción
- Alertas de errores
- Dashboards de uso

## Prioridad Baja

### 7. UX
- Animaciones de transición
- Sonidos de notificación
- Modo oscuro/claro
- Responsive mejorado

### 8. Deploy
- Dockerización
- CI/CD
- Deploy a cloud (Vercel, Railway, etc.)
