# Clinica Dental Demo

Demo full-stack para enseñar un flujo real con este Excel de clinica dental en la primera hoja:

- `Nombre y apellidos`
- `Fecha de nacimiento`
- `Telefono movil`
- `Tratamiento realizado`
- `Fecha del tratamiento`
- `Cantidad pagada (€)`
- `Casilla de presupuesto`

## Que hace la demo

1. Sube un Excel desde la UI.
2. Parsea la primera hoja.
3. Agrupa por `Tratamiento realizado`.
4. Crea o actualiza Google Sheets con una pestana por tratamiento.
5. Detecta cambios por polling o boton manual.
6. Envia WhatsApp real por Twilio.
7. Clasifica la respuesta con reglas fijas, sin LLM.
8. Crea o actualiza una cita real en Google Calendar.
9. Refleja estado y actividad en la UI y en Google Sheets.

## Stack

- Next.js 15 + App Router
- TypeScript
- Tailwind CSS
- `xlsx`
- `googleapis`
- `twilio`
- Estado demo en JSON local o en memoria segun `DEMO_STATELESS`

## Modo demo stateless

Si `DEMO_STATELESS=true`:

- la app arranca con estado limpio si no hay estado previo
- no depende de `data/demo-state.json` para funcionar
- no depende de guardar el Excel subido en filesystem persistente
- `Reset demo` vuelve el estado de la sesion al estado inicial
- un reinicio o redeploy deja la demo vacia y hay que volver a subir el Excel

Para robustez en Vercel, la app usa estos fallbacks:

- memoria de proceso para la sesion activa
- snapshot reenviado desde la UI al crear Sheets o refrescar
- Google Sheets como fuente recuperable cuando existe `GOOGLE_SPREADSHEET_ID`

## Archivos clave

- [lib/stateStore.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/lib/stateStore.ts)
- [lib/env.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/lib/env.ts)
- [services/excelService.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/services/excelService.ts)
- [services/sheetsService.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/services/sheetsService.ts)
- [services/triggerService.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/services/triggerService.ts)
- [services/twilioService.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/services/twilioService.ts)
- [services/calendarService.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/services/calendarService.ts)
- [app/api/webhooks/twilio/route.ts](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/app/api/webhooks/twilio/route.ts)

## Variables de entorno

Necesarias para Vercel:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CALENDAR_ID`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `APP_BASE_URL`
- `DEMO_STATELESS=true`

Opcionales:

- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_SHARE_WITH_EMAIL`
- `DEFAULT_COUNTRY_CODE`
- `APP_TIMEZONE`
- `TWILIO_CUMPLEANOS_MEDIA_URL`
- `GOOGLE_CALENDAR_URL`

Notas:

- `APP_BASE_URL` debe apuntar a tu dominio publico estable de Vercel, idealmente el dominio de produccion o un custom domain.
- Si `APP_BASE_URL` no esta definido, la app intenta resolver la URL publica desde la propia request o desde variables de Vercel.
- `GOOGLE_SPREADSHEET_ID` no es obligatorio, pero en Vercel es muy recomendable para reconstruir el estado tras cold starts y para que el webhook inbound pueda recuperar registros desde Google Sheets.

## Configurar Google Sheets real

1. Crea o reutiliza una service account.
2. Habilita APIs de Sheets y Drive.
3. Si dejas vacio `GOOGLE_SPREADSHEET_ID`, la app crea uno nuevo al pulsar `Crear Sheets`.
4. Si quieres que tu usuario humano lo vea, usa `GOOGLE_SHARE_WITH_EMAIL` o comparte el spreadsheet con la service account.

## Configurar Google Calendar real

1. Comparte el calendario con la service account.
2. Pon su ID en `GOOGLE_CALENDAR_ID`.
3. La app crea o actualiza eventos reales segun la intencion detectada.
4. Si quieres un boton directo a una URL concreta, define `GOOGLE_CALENDAR_URL`.

## Configurar Twilio WhatsApp real

1. Configura el sandbox o tu numero de WhatsApp Business en Twilio.
2. Pon el remitente en `TWILIO_WHATSAPP_FROM`.
3. Publica la app en Vercel.
4. Configura en Twilio este webhook entrante:

```text
https://TU-DOMINIO-VERCEL/api/webhooks/twilio
```

5. Si usas un dominio nuevo, actualiza `APP_BASE_URL` para que coincida con esa URL publica.

## Despliegue rapido en Vercel para demo

### 1. Desplegar

1. Importa este proyecto en Vercel como proyecto Next.js.
2. No hace falta abrir `ngrok` ni una segunda consola.
3. Usa el build command por defecto:

```bash
npm run build
```

4. Publica preferiblemente en produccion o en un dominio estable si Twilio va a apuntar ahi.

### 2. Configurar variables en Vercel

Define estas variables en Vercel:

```text
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_CALENDAR_ID
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
APP_BASE_URL=https://tu-demo.vercel.app
DEMO_STATELESS=true
```

Opcionales recomendadas:

```text
GOOGLE_SPREADSHEET_ID=...
TWILIO_CUMPLEANOS_MEDIA_URL=...
GOOGLE_CALENDAR_URL=...
```

### 3. Actualizar el webhook de Twilio

En Twilio, en el numero o sandbox de WhatsApp, configura:

```text
https://tu-demo.vercel.app/api/webhooks/twilio
```

Si cambias de dominio, actualiza tanto Twilio como `APP_BASE_URL`.

### 4. Probar el flujo completo

1. Abre la URL publica de Vercel.
2. Sube el Excel.
3. Pulsa `Procesar Excel`.
4. Pulsa `Crear Sheets`.
5. Pulsa `Abrir Google Sheet`.
6. Edita una fila en Google Sheets cambiando `tipo_accion`, `fecha_accion` o `hora_cita`.
7. Pulsa `Comprobar cambios` o espera el auto-check.
8. Verifica que Twilio envia el WhatsApp.
9. Responde al WhatsApp.
10. Revisa la UI, Google Sheets y Google Calendar.

## Arranque local

```bash
npm install
npm run demo:reset
npm run dev
```

Si quieres simular el modo desplegado:

```bash
$env:DEMO_STATELESS='true'
npm run dev
```

## Excel de prueba

Excel real del workspace:

- [clientes_clinica_dental_50_realista_2026.xlsx](/D:/- TOT EL DEMES/TREBALLS/FEINA ACTUAL/JT Redes y webs/Bot Excel/clientes_clinica_dental_50_realista_2026.xlsx)

## Endpoints

- `GET /api/state`
- `POST /api/state/refresh`
- `POST /api/state/reset`
- `POST /api/upload`
- `POST /api/process`
- `POST /api/triggers/check`
- `PATCH /api/records/:id`
- `POST /api/webhooks/twilio`

## Limitaciones conocidas en Vercel

- Sin `GOOGLE_SPREADSHEET_ID`, la recuperacion tras cold start depende mas del estado en memoria y del snapshot reenviado desde la UI.
- Un reinicio o redeploy borra el estado de sesion y hay que volver a subir el Excel.
- Los logs de la demo no sobreviven entre reinicios.
- La memoria de proceso en Vercel es best-effort; para la demo publicada conviene usar un dominio estable y fijar `GOOGLE_SPREADSHEET_ID`.

## Verificacion ejecutada

- `npm run typecheck`
- `npm run build`
