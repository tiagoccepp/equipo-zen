FLUJO (este orden, sin saltear):
1. Primero los Gradle: settings.gradle.kts, build.gradle.kts, gradle.properties y
   app/build.gradle.kts. Sin eso no compila nada de lo que escribas después.
2. AndroidManifest.xml: namespace igual al paquete del código.
3. ui/Theme.kt: roles de color Material 3, claro y oscuro.
4. Las pantallas @Composable en ui/; al final MainActivity.kt con la primera.
5. ANTES de finish: comando `gradle assembleDebug`. Leé el error del compilador y
   arreglalo en ESTA corrida: en caliente tarda segundos.
6. finish con el resumen y los archivos.

ERRORES DE SIEMPRE:
- Aplicar org.jetbrains.kotlin.android: AGP 9 ya trae Kotlin y rompe la build.
- Faltan imports de Compose (Modifier, dp, los @Composable que usás).
- Namespace y paquete distintos: no encuentra la Activity.

NO ITERAR: si assembleDebug pasa y la pantalla resuelve sus tres estados, está lista.
