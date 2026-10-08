# Aklatak — تطبيق Android وiPhone (MOBILE.md)

> النسخة 4.3. التطبيق هو **نفس منصّة Aklatak**: نفس السيرفر، نفس قاعدة البيانات، نفس الحسابات. لا يوجد نظام منفصل.

## ما أصبح جاهزاً في المنصّة
| | |
|---|---|
| قابلة للتثبيت كتطبيق | ملف التطبيق (manifest) + أيقونات PNG وmaskable بكل الأحجام + اختصارات (طبّاخ قريب / مطعم قريب) |
| بلا إنترنت | شاشة «لا يوجد اتصال» بأربع لغات بدل الانهيار؛ لا تُحفظ أي بيانات شخصية على الهاتف |
| iPhone | أيقونة الشاشة الرئيسية، وضع ملء الشاشة، شريط الحالة |
| فتح الروابط في التطبيق | `/.well-known/assetlinks.json` (Android) و`/.well-known/apple-app-site-association` (iPhone) — تُفعَّل بمتغيّرات البيئة |
| صفحة «حمّل التطبيق» `/app` | تعرض أزرار التنزيل التي تضعها من لوحة الإدارة، وطريقة التثبيت من المتصفح |
| الدخول والجلسة | نفس الحسابات؛ الجلسة تبقى بعد إغلاق التطبيق (كوكي آمن HttpOnly) |

## Android — بناء التطبيق من الهاتف (بدون كمبيوتر)
1. افتح **https://www.pwabuilder.com** في Chrome (اختر «موقع سطح المكتب»).
2. اكتب `https://sallatteta-platform.onrender.com` ← **Start**.
3. **Package for stores ← Android ← Generate Package**:
   - Package ID: `com.aklatak.app` · App name: `Aklatak` · Launcher name: `Aklatak`
   - Signing key: **Create new** (يُنشئ مفتاح توقيع لك)
4. نزّل الملف المضغوط. بداخله:
   - **`app-release-signed.apk`**: التطبيق نفسه — للتنزيل المباشر من موقعك.
   - `*.aab`: للنشر على Google Play لاحقاً.
   - **`signing.keystore` + `signing-key-info.txt`**: ⚠️ **مفتاح التطبيق وكلمة سرّه — احفظهما في مكان خاص (Google Drive خاص) ولا ترفعهما إلى GitHub أبداً.** إن ضاعا لا يمكن تحديث التطبيق نفسه بعد اليوم.
   - `assetlinks.json`: فيه بصمة المفتاح (SHA-256) — ليست سرّاً.
5. **رابط التنزيل**: في GitHub ← المشروع ← **Releases ← Draft a new release** ← ارفع ملف `app-release-signed.apk` ← **Publish**. انسخ رابط الملف.
6. لوحة الإدارة ← إعدادات الموقع ← **رابط تطبيق Android** ← الصق الرابط ← حفظ. يظهر زر «تحميل لأندرويد» في صفحة «تطبيق Aklatak».
7. **فتح الروابط في التطبيق** (ويخفي شريط المتصفح داخل التطبيق): في Render ← Environment أضف:
   - `ANDROID_PACKAGE_NAME` = `com.aklatak.app`
   - `ANDROID_SHA256_CERT_FINGERPRINTS` = البصمة من `assetlinks.json` (مثل `AB:CD:…`)
   ثم Manual Deploy.

> عند تثبيت APK من خارج Google Play يطلب Android «السماح بالتثبيت من هذا المصدر» — هذا طبيعي. النشر على Google Play (رسم 25$ مرة واحدة) يزيل هذا التنبيه ويعطي تحديثات تلقائية.

**تحديثات التطبيق:** لأن التطبيق يعرض المنصّة نفسها، **كل تحديث على الموقع يظهر فوراً في التطبيق** بدون إعادة بناء. إعادة البناء فقط إذا تغيّر الاسم أو الأيقونة.

## iPhone — ما تفرضه Apple
- لا يمكن توزيع تطبيق iPhone كملف مثل APK. الطرق: **App Store** أو **TestFlight** (للتجربة).
- يلزم **حساب Apple Developer** (99$ سنوياً).
- البناء يحتاج **Mac** أو خدمة بناء سحابية (مثل **Codemagic**، فيها خطة مجانية، وتعمل من المتصفح).
- الخطوات: PWABuilder ← iOS ← Generate (مشروع Xcode) ← البناء والتوقيع (Mac أو Codemagic) ← رفع إلى App Store Connect ← مراجعة Apple.
- بعد النشر: في Render أضف `IOS_APP_ID` = `TEAMID.com.aklatak.app`، وضع رابط App Store في لوحة الإدارة.
- **حتى ذلك الوقت**: مستخدمو iPhone يثبّتون المنصّة من Safari ← مشاركة ← «إضافة إلى الشاشة الرئيسية» (الشرح في صفحة `/app`).

## الأمان
- لا أسرار داخل التطبيق: كل المفاتيح على السيرفر فقط.
- مفتاح توقيع Android سرّ: لا يُرفع إلى GitHub.
- الجلسات بكوكي `HttpOnly + Secure + SameSite=Strict`؛ لا يُخزَّن أي رمز دخول في التخزين المحلي.
- الخدمة لا تخزّن ردود الـ API على الهاتف (خصوصية).
