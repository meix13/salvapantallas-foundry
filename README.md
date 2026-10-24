# Salvapantallas de Escena (Carrusel de Fondos) — FoundryVTT v14

Módulo para **FoundryVTT (v12 / v13 / v14)** que permite configurar **2 o más imágenes de fondo** (de las mismas proporciones) en cualquier escena para que roten automáticamente cada cierto tiempo (por defecto **20 segundos**) como un salvapantallas.

## Características

- **Sin pantallazos de recarga**: El cambio de imagen se realiza directamente sobre `canvas.primary.background` (`PrimarySpriteMesh` en PIXI.js) con precarga en memoria, evitando que Foundry recargue el lienzo a los jugadores.
- **Fundido suave (Crossfade)**: Transición progresiva configurable en segundos (ej. `1.5s`) entre la imagen saliente y la entrante, o corte directo (`0s`).
- **Sincronización automática**: Todos los jugadores conectados ven exactamente la misma imagen y las transiciones al mismo tiempo gracias al cálculo sobre el reloj del servidor (`game.time.serverTime`).
- **Configuración integrada en cada Escena**:
  - Abre **Configurar Escena → pestaña Básico** y encontrarás el panel **Salvapantallas de Escena (Carrusel de Fondos)** justo debajo de la imagen de fondo.
  - Botón rápido para añadir el fondo actual de la escena y selector de archivos (`FilePicker`) para añadir, reordenar o quitar imágenes.
- **Gestor Rápido en el Directorio de Escenas**: Botón `Salvapantallas Escenas` en la pestaña de Escenas para ver qué escenas tienen carrusel activo y saltar manualmente a la siguiente imagen si el GM lo desea.

## Instalación

URL del Manifiesto:
```text
https://raw.githubusercontent.com/meix13/salvapantallas-foundry/main/module.json
```

