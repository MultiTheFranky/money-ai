# money-ai

Cliente Node.js + TypeScript para conectar con la API de [Enable Banking](https://api.enablebanking.com)
y extraer los movimientos bancarios diarios en un formato simplificado, listo para enviar a un LLM.

## Estructura

```
src/
  types.ts    # Interfaces de cuentas, transacciones crudas y transacciones simplificadas
  config.ts   # Carga de variables de entorno (dotenv)
  auth.ts     # generateToken(): genera el JWT RS256 firmado con la clave privada
  api.ts      # getAccounts() y getTransactions(): llamadas a la API de Enable Banking
  parser.ts   # parseTransactionsForAI(): transforma las transacciones crudas
  index.ts    # main(): orquesta todo el flujo y muestra el resultado por consola
```

## Configuración

1. Copia `.env.example` a `.env` y completa los valores:
   - `CLIENT_ID`: tu Application ID de Enable Banking.
   - `KEY_PATH`: ruta al archivo `.pem` con tu clave privada RSA.
2. Instala las dependencias:
   ```
   npm install
   ```

## Uso

```
npm run dev     # ejecuta directamente con ts-node
npm run build   # compila a dist/
npm start        # ejecuta la versión compilada
```

## Docker

1. Copia tu clave privada RSA a `./keys/private_key.pem` (esta carpeta está montada como
   solo lectura y nunca se incluye dentro de la imagen).
2. Crea tu `.env` a partir de `.env.example` (no hace falta rellenar `KEY_PATH`, el
   `docker-compose.yml` ya lo apunta a `/app/keys/private_key.pem` dentro del contenedor).
3. Levanta el servicio:
   ```
   docker compose up --build
   ```
4. La app quedará disponible en `http://localhost:3000`.

Para pararlo: `docker compose down`.

> El contenedor corre como usuario no-root y persiste la cuenta bancaria vinculada
> (`bank-session.json`) en el volumen nombrado `money-ai-data`, gestionado por Docker
> (no un bind mount), evitando así problemas de permisos entre host y contenedor.
> Para inspeccionarlo: `docker volume inspect money-ai_money-ai-data`.

## CI/CD: publicación en Docker Hub

El workflow [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml) construye
y publica la imagen (`linux/amd64` y `linux/arm64`) en Docker Hub al hacer push a `master` o al crear
un tag `vX.Y.Z`. Configura estos secrets en GitHub (`Settings > Secrets and variables > Actions`):

- `DOCKERHUB_USERNAME`: tu usuario de Docker Hub.
- `DOCKERHUB_TOKEN`: un Access Token de Docker Hub (`Account Settings > Security > New Access Token`).

La imagen se publica como `<DOCKERHUB_USERNAME>/money-ai` con tags `latest`, `<versión>` (si haces
push de un tag semver) y el hash corto del commit.
