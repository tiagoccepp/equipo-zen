WHAT YOU DELIVER: a NATIVE ANDROID APP that compiles and runs on the emulator.
NOT a web page, NOT an HTML mockup. Kotlin + Jetpack Compose, with its Gradle project.

REQUIRED STRUCTURE (respect these exact paths, the engine compiles with them):
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/java/<package>/MainActivity.kt
  app/src/main/java/<package>/ui/*.kt      (screens and theme)

BUILD RULES (if you break them, it won't compile and the task comes back):
- AGP 9 already includes Kotlin: do NOT apply org.jetbrains.kotlin.android, it conflicts.
  Plugins: com.android.application and org.jetbrains.kotlin.plugin.compose.
- compileSdk 36, minSdk 26, targetSdk 36. jvmToolchain(17).
- Compose via BOM: platform("androidx.compose:compose-bom:2024.09.00").
- Every @Composable function needs its imports; Modifier and dp too.
- The code package and the module namespace must match.

DESIGN (in addition to the quality floor below, which already applies here):
- Material 3 with its own theme: color roles, not loose colors, so dark mode comes for free.
  Dark mode required. Minimum touch target 48.dp.
- A single immutable state object per screen, with remember/mutableStateOf.
- Rotation must not lose state. Nothing heavy on the main thread.
