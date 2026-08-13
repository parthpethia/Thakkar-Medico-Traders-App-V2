/**
 * Build APK & Multi-Destination Output Distributor
 * 
 * Builds the Android APK (Release or Debug) and automatically distributes copies
 * to multiple convenient locations:
 *  1. User's Downloads directory (with versioned, timestamped, and 'latest' names)
 *  2. Project root 'build-output/apk/' directory
 *  3. Project 'dist/apk/' directory
 *  4. Android native build outputs directory
 * 
 * Also generates build-info.json with SHA-256 checksum, size, and build metadata.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(PROJECT_ROOT, 'android');

// Parse CLI Arguments
const args = process.argv.slice(2);
const isDebug = args.includes('debug') || args.includes('--debug');
const buildType = isDebug ? 'debug' : 'release';
const isClean = args.includes('--clean');
const skipDownloads = args.includes('--no-downloads');

// Load App Metadata
let appVersion = '1.0.0';
let appName = 'Thakkar-Medico';

try {
  const appJsonPath = path.join(PROJECT_ROOT, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    if (appJson?.expo?.version) appVersion = appJson.expo.version;
    if (appJson?.expo?.name) appName = appJson.expo.name.replace(/\s+/g, '-');
  }
} catch (e) {
  // fallback to defaults
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const dateString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function calculateSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function runBuild() {
  console.log('\n' + '='.repeat(70));
  console.log(`  🚀  BUILDING ${appName.toUpperCase()} ANDROID APK (${buildType.toUpperCase()})`);
  console.log('='.repeat(70));
  console.log(`  📅  Time:       ${dateString}`);
  console.log(`  📦  Version:    v${appVersion}`);
  console.log(`  ⚙️   Build Type: ${buildType}`);
  console.log(`  📂  Project:    ${PROJECT_ROOT}`);
  console.log('='.repeat(70) + '\n');

  const startTime = Date.now();

  // Environment Setup
  const env = { ...process.env };
  if (!env.SENTRY_AUTH_TOKEN) {
    env.SENTRY_DISABLE_AUTO_UPLOAD = 'true';
  }

  
  // Find existing PATH key (case-insensitive: 'Path', 'PATH', etc.)
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const existingPath = env[pathKey] || '';
  
  const possibleJavaHome = 'C:\\Program Files\\Java\\jdk-17';
  const nodeBinDir = path.dirname(process.execPath);
  
  const additionalPaths = [];
  if (fs.existsSync(possibleJavaHome)) {
    env.JAVA_HOME = possibleJavaHome;
    additionalPaths.push(path.join(possibleJavaHome, 'bin'));
  }
  if (nodeBinDir) {
    additionalPaths.push(nodeBinDir);
  }
  
  // Update the original PATH key directly (and clear any duplicate case variant if present)
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) {
      delete env[key];
    }
  }
  env[pathKey] = `${additionalPaths.join(path.delimiter)}${path.delimiter}${existingPath}`;

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  const gradleTask = buildType === 'release' ? 'app:assembleRelease' : 'app:assembleDebug';

  const gradleArgs = [];
  if (isClean) gradleArgs.push('clean');
  gradleArgs.push(gradleTask);
  gradleArgs.push('--no-daemon');
  gradleArgs.push('-Dorg.gradle.parallel=true');
  gradleArgs.push('-Dorg.gradle.caching=true');

  console.log(`▶ Executing: ${gradlewCmd} ${gradleArgs.join(' ')} (in android/)\n`);

  const buildProcess = spawn(gradlewCmd, gradleArgs, {
    cwd: ANDROID_DIR,
    env,
    shell: true,
    stdio: 'inherit',
  });

  const exitCode = await new Promise((resolve) => {
    buildProcess.on('close', (code) => resolve(code));
    buildProcess.on('error', (err) => {
      console.error('Failed to spawn gradle:', err);
      resolve(1);
    });
  });

  if (exitCode !== 0) {
    console.error(`\n❌ Gradle build failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✨ Gradle build finished in ${durationSec}s!`);

  // Source APK location
  const sourceApkRelPath = path.join('android', 'app', 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`);
  const sourceApkPath = path.join(PROJECT_ROOT, sourceApkRelPath);

  if (!fs.existsSync(sourceApkPath)) {
    console.error(`\n❌ Could not find expected APK at: ${sourceApkPath}`);
    process.exit(1);
  }

  const stats = fs.statSync(sourceApkPath);
  const fileSize = formatBytes(stats.size);
  const sha256 = calculateSha256(sourceApkPath);

  console.log('\n' + '='.repeat(70));
  console.log('  📤  DISTRIBUTING APK TO MULTIPLE OUTPUT LOCATIONS');
  console.log('='.repeat(70));

  const outputs = [];

  // Destination 1: Project Root build-output/apk
  const projectOutputDir = path.join(PROJECT_ROOT, 'build-output', 'apk');
  ensureDir(projectOutputDir);

  const versionedApkName = `${appName}-v${appVersion}-${buildType}.apk`;
  const timestampApkName = `${appName}-v${appVersion}-${buildType}-${timestamp}.apk`;
  const latestApkName = `${appName}-latest.apk`;

  const destVersioned = path.join(projectOutputDir, versionedApkName);
  const destTimestamp = path.join(projectOutputDir, timestampApkName);
  const destLatest = path.join(projectOutputDir, latestApkName);

  fs.copyFileSync(sourceApkPath, destVersioned);
  fs.copyFileSync(sourceApkPath, destTimestamp);
  fs.copyFileSync(sourceApkPath, destLatest);

  outputs.push({
    title: 'Project Build Output (Versioned)',
    path: destVersioned,
  });
  outputs.push({
    title: 'Project Build Output (Timestamped)',
    path: destTimestamp,
  });
  outputs.push({
    title: 'Project Build Output (Latest Link)',
    path: destLatest,
  });

  // Destination 2: Project dist/apk
  const distOutputDir = path.join(PROJECT_ROOT, 'dist', 'apk');
  ensureDir(distOutputDir);
  const destDistVersioned = path.join(distOutputDir, versionedApkName);
  const destDistLatest = path.join(distOutputDir, latestApkName);
  fs.copyFileSync(sourceApkPath, destDistVersioned);
  fs.copyFileSync(sourceApkPath, destDistLatest);

  outputs.push({
    title: 'Project Dist Folder',
    path: destDistVersioned,
  });

  // Destination 3: User Downloads folder
  if (!skipDownloads) {
    const userDownloadsDir = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(userDownloadsDir)) {
      const downloadVersioned = path.join(userDownloadsDir, versionedApkName);
      const downloadTimestamp = path.join(userDownloadsDir, timestampApkName);
      const downloadLatest = path.join(userDownloadsDir, latestApkName);

      fs.copyFileSync(sourceApkPath, downloadVersioned);
      fs.copyFileSync(sourceApkPath, downloadTimestamp);
      fs.copyFileSync(sourceApkPath, downloadLatest);

      outputs.push({
        title: '📥 User Downloads (Latest)',
        path: downloadLatest,
      });
      outputs.push({
        title: '📥 User Downloads (Versioned)',
        path: downloadVersioned,
      });
      outputs.push({
        title: '📥 User Downloads (Timestamped Archive)',
        path: downloadTimestamp,
      });
    }
  }

  // Destination 4: Native Android Output
  outputs.push({
    title: 'Android Native Gradle Output',
    path: sourceApkPath,
  });

  // Generate build-info.json metadata
  const buildInfo = {
    appName,
    version: appVersion,
    buildType,
    builtAt: dateString,
    timestamp,
    buildDurationSeconds: durationSec,
    fileSizeBytes: stats.size,
    fileSizeFormatted: fileSize,
    sha256Checksum: sha256,
    outputs: outputs.map((o) => ({ label: o.title, path: o.path })),
  };

  const buildInfoPath = path.join(projectOutputDir, 'build-info.json');
  fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2), 'utf8');

  // Print Summary Table
  console.log(`\n  ✅  APK BUILD & DISTRIBUTION COMPLETED SUCCESSFULLY!`);
  console.log(`  ⏱️   Duration:   ${durationSec}s`);
  console.log(`  📊  File Size:  ${fileSize} (${stats.size.toLocaleString()} bytes)`);
  console.log(`  🔒  SHA-256:    ${sha256}`);
  console.log(`  📄  Build Info: ${buildInfoPath}\n`);

  console.log('  📍  OUTPUT LOCATIONS:');
  outputs.forEach((item, index) => {
    console.log(`   ${index + 1}. [${item.title}]`);
    console.log(`      ➜ ${item.path}`);
  });
  console.log('\n' + '='.repeat(70) + '\n');
}

runBuild().catch((err) => {
  console.error('Unexpected error during build:', err);
  process.exit(1);
});
