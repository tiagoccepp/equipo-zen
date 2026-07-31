QUÉ ENTREGÁS: una APP ANDROID NATIVA que compila y corre en el emulador.
NO una web, NO una maqueta HTML. Kotlin + Jetpack Compose, con su proyecto Gradle.

ESTRUCTURA OBLIGATORIA (respetá estas rutas exactas, el motor compila con ellas):
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/java/<paquete>/MainActivity.kt
  app/src/main/java/<paquete>/ui/*.kt      (pantallas y tema)

REGLAS DE LA COMPILACIÓN (si las rompés, no compila y la tarea vuelve):
- AGP 9 ya trae Kotlin: NO apliques org.jetbrains.kotlin.android, choca.
  Plugins: com.android.application y org.jetbrains.kotlin.plugin.compose.
- compileSdk 36, minSdk 26, targetSdk 36. jvmToolchain(17).
- Compose por BOM: platform("androidx.compose:compose-bom:2024.09.00").
- Toda función @Composable necesita sus imports; Modifier y dp también.
- El paquete del código y el namespace del módulo tienen que coincidir.

DISEÑO (además del piso de calidad de abajo, que ya vale acá):
- Material 3 con tema propio: roles de color, no colores sueltos, así el modo
  oscuro sale solo. Modo oscuro obligatorio. Área táctil mínima 48.dp.
- Un solo objeto inmutable de estado por pantalla, con remember/mutableStateOf.
- Rotar no puede perder el estado. Nada pesado en el hilo principal.
