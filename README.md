# BESTO OS · CRM comercial

CRM en español para registrar prospectos, seguir visitas y demos, y convertir ventas confirmadas en clientes. Las fichas conservan el historial de etapas, notas, llamadas, reuniones, correos y mensajes de WhatsApp. El enlace de WhatsApp abre la conversación y el registro del mensaje se hace desde la ficha. La agenda usa la hora de Colombia y los valores comerciales están en COP.

| Usuario | Rol | Alcance |
| --- | --- | --- |
| `jhon` | Encargado de ventas | Consulta todo el equipo y asigna o reasigna leads. Puede filtrar por encargado. |
| `pelos` | Ventas | Crea, consulta y actualiza las fichas asignadas a su cuenta. |
| `alejandra` | Ventas | Crea, consulta y actualiza las fichas asignadas a su cuenta. |

El servidor aplica los permisos en cada operación. Las contraseñas se configuran fuera del repositorio.

## Ejecutar en local

1. Instala Node.js 24 y ejecuta `npm ci`.
2. Copia `.env.example` a `.env.development.local`. Usa `chmod 600 .env.development.local` para restringir el acceso local.
3. Genera `CRM_SESSION_SECRET` con `openssl rand -hex 32`.
4. Para cada usuario, genera el hash con el siguiente comando en Bash. Guarda el resultado en `CRM_JHON_PASSWORD_HASH`, `CRM_PELOS_PASSWORD_HASH` o `CRM_ALEJANDRA_PASSWORD_HASH`, según corresponda.

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

5. Ejecuta `npm run dev` y abre `http://localhost:3000`. SQLite crea el archivo de datos local al primer acceso. Para usar Supabase, configura `DATABASE_URL` (ver Despliegue).

## Importar contactos

El encargado de ventas puede abrir **Importar contactos** desde el Embudo o Contactos. Selecciona un Excel `.xlsx` o CSV UTF-8 de hasta 4 MB, elige el responsable predeterminado y revisa el resumen antes de confirmar.

El formato BESTO usa los encabezados **Código**, **Nombre de la persona**, **Teléfono**, **Correo**, **Nombre del establecimiento** y **Actividad**. El importador reconoce variantes como **Nombre**, **Celular**, **Email** y **Empresa**. El nombre de cada hoja Excel se agrega como etiqueta. Una columna opcional **Responsable** puede indicar `jhon`, `pelos` o `alejandra` por fila. Las filas repetidas se omiten al volver a cargar el mismo archivo.

## Despliegue

Configura `CRM_SESSION_SECRET` y los hashes de contraseña como secretos de Vercel en Production y Preview. Configura `DATABASE_URL` con la cadena de conexión de Supabase de cada entorno: en el panel de Supabase, **Connect → Connection string → Transaction pooler** (puerto `6543`). El servidor se conecta directo a Postgres; no usa la clave publicable ni la API de datos de Supabase. El CRM crea sus tablas automáticamente y activa RLS sin políticas, así que la API pública no puede leerlas. El esquema también está en `supabase/migrations/` para aplicarlo desde el editor SQL o con `supabase db push`. Vuelve a desplegar después de cambiar un secreto. La protección de despliegues de Vercel y las cuentas del CRM controlan accesos distintos.

## Seguridad

- **Conexión a la base de datos.** El servidor verifica el certificado de Postgres. Si el proveedor usa una CA que Node no conoce, descarga su certificado (en Supabase: **Database → Settings → SSL Configuration**) y guárdalo en `DATABASE_CA_CERT` como PEM, con `\n` en lugar de saltos de línea. `DATABASE_TLS_VERIFY=false` desactiva la verificación; úsalo solo como medida temporal y explícita, porque deja la conexión expuesta a interceptación.
- **Sesiones.** Cada inicio de sesión se guarda en la tabla `besto_sessions`. Cerrar sesión la revoca en el servidor, y cambiar la contraseña de un usuario invalida todas sus sesiones. La cookie dura 7 días como máximo.
- **Intentos de inicio de sesión.** Cada cuenta admite 8 intentos fallidos cada 15 minutos **por dirección de origen**, y cada dirección admite 20 en total. Así, un desconocido no puede bloquear la cuenta de otra persona. La dirección se lee de `X-Forwarded-For` solo en Vercel o si defines `CRM_TRUST_PROXY=1`; actívalo únicamente detrás de un proxy que añada la dirección real. Sin proxy de confianza, todos los clientes comparten la dirección `local` y solo rige el límite por cuenta.
- **Eliminar contactos.** Solo el encargado de ventas puede eliminar contactos.
- **Cabeceras.** Todas las respuestas llevan CSP, HSTS y aislamiento de origen cruzado (ver `next.config.ts`). La CSP mantiene `unsafe-inline` en scripts y estilos porque Next.js inserta scripts en línea; el resto del origen queda restringido.
- **MCP.** `.mcp.json` conecta Supabase en solo lectura y sin acceso a la cuenta. No lo amplíes en un repositorio compartido.

## Verificación

```bash
npm run check
npm test
npm run build
```

Las pruebas HTTP levantan su propia copia del servidor con una base temporal dentro de `.data/` y generan credenciales de prueba para verificar permisos, historial, concurrencia, persistencia, sesiones, límites de intentos y cabeceras. Se ejecutan de una en una; tardan unos dos minutos.
