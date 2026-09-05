# Android project notes

`npx cap add android` generates the Gradle project. The settings below are the
ones worth applying afterwards; they are kept here rather than in generated
files so a regenerated project does not silently lose them.

## `android/app/src/main/AndroidManifest.xml`

The app needs the network, and the camera only for photographing invoices:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

Cleartext traffic stays off — the API is HTTPS only:

```xml
<application
    android:usesCleartextTraffic="false"
    android:allowBackup="false"
    ...>
```

`allowBackup="false"` matters here: the app holds a session token, and Android's
automatic backup would copy it off the device.

## `android/app/build.gradle`

```gradle
android {
    defaultConfig {
        applicationId "sa.maralounge.buyer"
        minSdkVersion 24
        targetSdkVersion 34
        versionCode 1
        versionName "1.0.0"
    }
    buildTypes {
        release {
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

## Network security

The default configuration already refuses cleartext. If the branch uses an
internal certificate authority, add a `network_security_config.xml` pinning it
rather than disabling verification.
