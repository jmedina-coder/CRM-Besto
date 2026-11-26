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

## Verificación

```bash
npm run check
npm test
npm run build
```

La prueba HTTP usa su propia base temporal y genera credenciales de prueba para verificar permisos, historial, concurrencia y persistencia.
