# BESTO OS · CRM comercial

CRM en español para registrar prospectos, seguir visitas y demos, y convertir ventas confirmadas en clientes. Las fichas conservan el historial de etapas, notas, llamadas, reuniones, correos y mensajes de WhatsApp. El enlace de WhatsApp abre la conversación y el registro del mensaje se hace desde la ficha. La agenda usa la hora de Colombia y los valores comerciales están en COP.

| Usuario | Rol | Alcance |
| --- | --- | --- |
| `jhon` | Encargado de ventas | Consulta todo el equipo y asigna o reasigna leads. Puede filtrar por encargado. |
| `pelos` | Ventas | Crea, consulta y actualiza las fichas asignadas a su cuenta. |

El servidor aplica los permisos en cada operación. Las contraseñas se configuran fuera del repositorio.

## Ejecutar en local

1. Instala Node.js 24 y ejecuta `npm ci`.
2. Copia `.env.example` a `.env.development.local`. Usa `chmod 600 .env.development.local` para restringir el acceso local.
3. Genera `CRM_SESSION_SECRET` con `openssl rand -hex 32`.
4. Para cada usuario, genera el hash con el siguiente comando en Bash. Guarda el resultado en la variable `CRM_JHON_PASSWORD_HASH` o `CRM_PELOS_PASSWORD_HASH` correspondiente.

   ```bash
   read -rs -p 'Contraseña: ' besto_password
   printf '\n' >&2
   printf '%s' "$besto_password" | node --input-type=module -e '
     import { randomBytes, scryptSync } from "node:crypto";
     import { readFileSync } from "node:fs";
     const salt = randomBytes(16);
     const key = scryptSync(readFileSync(0), salt, 32);
     console.log(`scrypt:${salt.toString("hex")}:${key.toString("hex")}`);
   '
   unset besto_password
   ```

5. Ejecuta `npm run dev` y abre `http://localhost:3000`. SQLite crea el archivo de datos local al primer acceso. Para usar un Postgres externo, configura `DATABASE_URL`.

## Despliegue provisional

Configura las tres variables de autenticación como secretos de Preview y conecta una base de datos Neon Postgres dedicada para `DATABASE_URL`. El CRM crea sus tablas automáticamente. El código y las variables se administran por separado. La protección de despliegues de Vercel y las cuentas del CRM controlan accesos distintos.

## Verificación

```bash
npm run check
npm test
npm run build
```

La prueba HTTP usa su propia base temporal y genera credenciales de prueba para verificar permisos, historial, concurrencia y persistencia.
