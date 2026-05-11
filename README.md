# Almacen Tablet

Aplicacion cliente-servidor para una tablet tactil de almacen.

## Requisitos

- Node.js 20 o superior
- MongoDB escuchando en `mongodb://127.0.0.1:27017`

## Arranque

```bash
npm install
npm start
```

La app queda disponible en:

```text
http://localhost:3000
```

## Configuracion

Copia `.env.example` a `.env` si quieres cambiar puerto, base de datos o PIN:

```text
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=almacen_tablet
ADMIN_PIN=1234
ADMIN_TOKEN_SECRET=cambia-esta-clave
APP_TIMEZONE=Europe/Madrid
```

El PIN de administrador por defecto es `1234`.

## Flujo de uso

- `Stock`: sin login, botones tactiles para subir o bajar una unidad. Los productos se agrupan por pestanas de categoria y cada toque se guarda en MongoDB.
- `Parte`: el trabajador introduce su codigo de dos numeros y entra automaticamente. Los checks y comentarios se guardan al momento.
- `Turno`: vista publica de tareas compartidas del turno de manana o tarde.
- `Circulares`: vista publica de avisos y archivos publicados por administracion.
- `Admin`: alta/baja de categorias, productos, trabajadores, turnos fijos por dia, tareas diarias, tareas puntuales, circulares y consulta de partes cerrados.

Los trabajadores pueden estar en manana, tarde, ambos turnos o libre por cada dia fijo de la semana. Las tareas de turno pueden ser de manana, tarde o de todo el dia.

Las tareas pueden llevar productividad opcional: item y cantidad objetivo. En ese caso el trabajador puede sumar una cantidad parcial o completar lo que falte. Las tareas compartidas suman la produccion de todos y quedan completadas cuando alcanzan el objetivo.

Las tareas recurrentes se generan por fecha. En cada llamada a la API el servidor comprueba la fecha; si detecta un dia nuevo, cierra los dias anteriores, crea resumenes definitivos en `dailySummaries` y genera las tareas del nuevo dia. No depende de un cronjob.

En `Admin > Partes` se ve el estado en vivo de todos los trabajadores y se refresca automaticamente mientras esa pantalla esta abierta.
