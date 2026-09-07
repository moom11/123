# MARA Buyer (Android)

The purchasing rep's app. Deliberately narrow: approved purchase requests, the
aggregated shopping list, price history, purchase entry, invoice capture and
delivery status.

There is no POS, no customer data and no financial reporting here — not hidden
behind a flag, simply absent, and refused by the server for this role in any
case.

## The rule this app exists to respect

A request becomes visible to the rep only once a branch manager has approved
it, and only ever at the quantity the manager approved. That is enforced in the
database — the app reads `buyer_purchase_requests`, a view that contains
nothing but approved-and-beyond requests and exposes `approved_quantity` rather
than `requested_quantity`. Buying beyond the approval is refused by the server;
the rep raises **طلب تعديل** and the manager decides.

## Offline

The rep works in warehouses and loading bays. The approved work list is cached
in IndexedDB, and actions taken without a signal are queued and replayed in
order when the connection returns. Each queued purchase carries a
client-generated reference that the server de-duplicates on, so a replay after
a timeout cannot record the same purchase twice.

Three outcomes are kept distinct, because confusing them would be costly:

| Outcome | What the rep sees |
|---|---|
| Accepted | "تم تسجيل الشراء" |
| Held offline | "حُفظ محلياً — سيُرسل عند عودة الشبكة" |
| Refused by the server | The reason, with the form still open to correct |

## Build the APK

```bash
npm install
npm run build              # web assets
npx cap add android        # first time only
npm run android:sync       # copy assets into the Android project
npm run android:open       # open in Android Studio

# or straight to a release APK:
cd android && ./gradlew assembleRelease
```

The app ships without a hard-coded server: on first launch, if the API cannot
be reached at the default origin, it asks for the server address and stores it.

### Signing

Create a keystore once and reference it from `android/app/build.gradle`:

```bash
keytool -genkey -v -keystore mara-buyer.keystore \
  -alias mara -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore and its passwords out of the repository.
