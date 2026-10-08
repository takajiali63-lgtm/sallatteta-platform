# سلة تيتا — المواصفات الكاملة (v2.4.0)

> الروابط والحسابات والاستضافة وطريقة التحديث في [`HANDOVER.md`](HANDOVER.md).

> واجهة الموقع كلها بالعربية الفصحى وبخطاب موجّه للجميع. نوع الطلب (`serviceType`) ما عاد ظاهر بالواجهة، بس الـ API لسا بيقبلو كفلتر اختياري.

هالملف هو المرجع لبناء أي واجهة جديدة (تطبيق Android/iOS، أو موقع بتصميم تاني) فوق نفس السيرفر. كل شي بالموقع الحالي بيمشي عبر الـ API الموصوف هون، فالتطبيق بيقدر يعمل نفس الشي بالظبط.

---

## 1. الأدوار

| الدور | الدخول | شو بيعمل |
|---|---|---|
| زبونة | بدون حساب | بتطلب، بتختار ست، بتفتح WhatsApp، بتقيّم، بتعمل إعجاب، بتبعت شكوى |
| ست (طبّاخة) | رقم WhatsApp + كلمة سر (من الإدارة) | بتشوف أرقامها، بتنزّل صور، بتعدّل صفحتها وضيعها |
| إدارة | اسم مستخدم + كلمة سر | كل شي: قبول، اشتراكات، شكاوي، إنذارات، صور، ضيع |

الزبونة ما عندها حساب. التطبيق بيحفظ على الجهاز:
- `viewerId`: رمز عشوائي (8–64 حرف `[A-Za-z0-9_-]`) للإعجاب والزيارات.
- «طبّاخاتي»: لائحة `{id, name, reviewToken, at, rating}` للستات اللي تواصلت معهن.

---

## 2. الرحلات

### زبونة — طلب جديد
1. `GET /api/config` (أنواع الطلبات، الأقضية).
2. بتكتب الطلب (5–1000 حرف)، واختياري نوع الطلب.
3. **تحديد الموقع بالـ GPS إجباري** بالموقع (الـ API لسا بيقبل `{type:'area', areaId}` لتطبيقات مستقبلية).
4. `POST /api/search` ← لائحة الستات اللي بيوصلوا على هالضيعة، الأقرب أولاً + `requestId`.
5. بتختار ست ← `POST /api/contact {requestId, cookId}` ← `whatsappUrl` + `reviewToken`.
6. التطبيق بيفتح `whatsappUrl` وبيحفظ الست بـ «طبّاخاتي» مع `reviewToken`.
7. بعدين: `POST /api/reviews {token, rating}`.

### زبونة — من صفحة ست
1. `GET /api/cooks/:id?viewerId=`، و`POST /api/cooks/:id/view {viewerId}`.
2. «اطلب الآن»: الطلب + تحديد الموقع ← `POST /api/cooks/:id/request {text, lat, lng}` ← `requestId`.
3. `POST /api/contact` متل فوق.

### طبّاخ — اشتراك
0. **تحديد الموقع إجباري** ← `GET /api/areas/around?lat=&lng=` ← البلدات المحيطة (مش مختارة).
1. `/join`: الاسم، الرقم، ضيعتها (`areaId`)، الضيع اللي بتوصلها (`servedAreaIds` — الاقتراحات من `GET /api/areas/nearby?areaId=` بتطلع **مش مختارة**)، الخدمات، المدة، صورة ووصف اختياريين، «ما لقيت ضيعتي» (`missingVillage`).
2. `POST /api/cook-applications` ← `whatsappUrl` لرقم الإدارة، والرسالة جاهزة.
3. الإدارة بتفعّل الاشتراك وبتبعتلها كلمة سر.

### ست — حسابها
`POST /api/cook/login` ← كوكي `st_cook` (60 يوم) ← `GET /api/cook/me`، إلخ.

---

## 3. قاعدة البيانات

PostgreSQL بالإنتاج، SQLite محلياً والاختبارات (نفس SQL). التواريخ `TIMESTAMPTZ` (نص ISO بـ SQLite).

| الجدول | الوصف | أعمدة مهمة |
|---|---|---|
| `service_areas` | الضيع | `id, slug UNIQUE, name_ar, name_en, district, lat, lng, is_active` |
| `service_types` | أنواع الطلبات | `key`: home_cooking, pastries, sweets, mouneh, mezze, feasts |
| `cooks` | الستات | `full_name, whatsapp` (دولي، أرقام بس)`, area_id` (ضيعتها)`, lat, lng, bio, photo` (data URL)`, status` (pending/approved/rejected)`, password_hash, admin_notes`. (`service_radius_km` قديم وما عاد مستعمل) |
| `cook_service_areas` | الضيع اللي بتوصلها كل ست | `(cook_id, area_id)` |
| `cook_service_types` | شو بتحضّر | `(cook_id, service_type_id)` |
| `subscriptions` | الاشتراكات | `plan` (monthly/quarterly/semiannual/yearly)`, status` (pending/active/expired/suspended)`, payment_status, start_date, expiry_date` |
| `requests` | كل طلب زبونة | `public_id, body, area_label, approx_lat/lng` (مقرّب)`, location_source` (gps/area/profile)`, results_count` |
| `request_impressions` | مين ظهر بكل طلب | `request_id, cook_id, distance_km, position` |
| `request_contact_events` | ضغطات WhatsApp | `request_id, cook_id, review_token UNIQUE` |
| `reviews` | النجوم | `cook_id, contact_event_id UNIQUE, rating 1–5, is_hidden` |
| `feedback` | شكاوي وملاحظات (إدارة بس) | `cook_id, kind` (complaint/note)`, message, customer_name, customer_phone, status` (new/resolved)`, admin_note` |
| `cook_warnings` | الإنذارات | `cook_id, admin_id, feedback_id, message` |
| `cook_likes` | الإعجابات | `(cook_id, viewer_hash)` |
| `cook_page_views` | زيارات الصفحة | `cook_id, viewer_hash, created_at` (مرة كل 12 ساعة لكل جهاز) |
| `cook_photos` | صور الأكل | `cook_id, data` (data URL، فاضي إذا الصورة بالتخزين الخارجي)`, url` (رابط R2/S3)`, caption, is_hidden` — حد أقصى 12 |
| `cook_sessions`, `admin_sessions` | الجلسات | `token_hash, expires_at` |
| `admin_users`, `admin_actions` | الإدارة وسجل عملياتها | |
| `app_meta` | إعدادات داخلية | `seed_version` |

**متى يظهر الطبّاخ؟** `cooks.status='approved'` + اشتراك `active` و`start_date <= الآن < expiry_date` + (للبحث) سطر بـ `cook_service_areas` لواحدة من بلدات الزبون: بالـ GPS = الأقرب لموقعه + كل بلدة ضمن 1.5 كم؛ بالاسم = البلدة نفسها.

---

## 4. الـ API

- كل الطلبات والأجوبة JSON. اللغة من `?lang=` أو `Accept-Language` (ar الافتراضي).
- **الطلبات اللي بتغيّر شي** لحساب الست والإدارة لازم فيها الهيدر `X-Requested-With: fetch` (حماية CSRF). تطبيق موبايل بيبعتو دايماً.
- **الأخطاء:** `{ "error": "code", "fields": { "field": "code" } }`. الأكواد: `validation_failed` (422)، `rate_limited` (429، مع `retryAfterSec`)، `unauthorized` (401)، `not_found`، `cook_not_available`، `request_expired` (410)، `too_many_photos` (409)... والنصوص العربية بـ `locales/ar.json` ← `errors.*`.
- **الحماية ضد السبام** بالنماذج العامة: `website` لازم يكون فاضي، و`startedAt` (ms) إذا انبعت لازم يكون قبل 1.5 ثانية عالأقل.

### عام — الضيع
| | المسار | الجواب |
|---|---|---|
| GET | `/api/config` | `{serviceTypes[], plans[], districts[{key,name}], maxPhotos, adminContactConfigured}` |
| GET | `/api/areas/search?q=` | `{areas[{id,name,district,districtName}]}` (12 نتيجة) |
| GET | `/api/areas/nearby?areaId=&km=15` | `{areas[... ,distanceKm]}` الأقرب أولاً، والأولى هي نفسها |
| GET | `/api/areas/around?lat=&lng=` | `{source: osm\|cache\|fallback, nearest, areas[... ,distanceKm]}` — البلدات ضمن 15 كم، من OpenStreetMap (بتنحفظ)، الأقرب أولاً |
| GET | `/api/areas/nearest?lat=&lng=` | `{area}` |
| GET | `/api/areas/district?key=` | `{areas[]}` كل ضيع القضاء |

### عام — الطلب والتواصل
| | المسار | الـ body | الجواب |
|---|---|---|---|
| POST | `/api/search` | `{text, serviceType?, location: {type:'area', areaId} \| {type:'gps', lat, lng}, website, startedAt}` | `{requestId, area, areaLabel, cooks[CookCard + distanceKm]}` |
| POST | `/api/cooks/:id/request` | `{text, lat, lng` (أو `areaId`)`, website, startedAt}` | `{requestId}` |
| POST | `/api/contact` | `{requestId, cookId}` | `{whatsappUrl, reviewToken, cook{id,name}}` — الطلب صالح 48 ساعة، والست لازم تكون ظهرت فيه |

**CookCard:** `{id, name, area, services[], bio, photoUrl|null, rating{avg|null, count}, profileUrl, subscriptionStatus}` — **بلا رقم وبلا إحداثيات**.

### عام — الاكتشاف وصفحة الست
| | المسار | الجواب |
|---|---|---|
| GET | `/api/feed` | `{dishes[{photoUrl, caption, cookId, cookName, area, profileUrl}], cooks[CookCard]}` |
| GET | `/api/cooks/search?q=` | `{cooks[CookCard]}` (حرفين عالأقل) |
| GET | `/api/cooks/:id?viewerId=` | CookCard + `{servedAreas[{id,name}], photos[{id,url,caption}], likes, likedByMe}` — 404 إذا مش ظاهرة |
| POST | `/api/cooks/:id/view` | `{viewerId}` ← `{ok}` |
| POST | `/api/cooks/:id/like` | `{viewerId, like: true\|false}` ← `{likes, likedByMe}` |
| POST | `/api/reviews` | `{token, rating 1–5}` ← `{ok, cookId, rating}` — بيتعدّل إذا انبعت مرة تانية. صالح 60 يوم |
| POST | `/api/feedback` | `{cookId, kind: complaint\|note, message 5–1500, name?, phone?, website, startedAt}` ← 201 |
| POST | `/api/cook-applications` | `{fullName, whatsapp, lat, lng` (**إجباري**، GPS)`, servedAreaIds[], services[], plan, areaLabel?` (للمعلومات)`, areaId?, bio?, photo?, website, startedAt}` — الرسالة للإدارة فيها رابط الموقع على الخريطة ← `{applicationId, whatsappUrl}` |
| GET | `/media/cooks/:id.jpg`, `/media/photos/:id.jpg` | الصور (للستات الظاهرات بس) |
| GET | `/healthz` | `{ok:true}` |

### حساب الست (كوكي `st_cook`)
| | المسار | الـ body / الجواب |
|---|---|---|
| POST | `/api/cook/login` | `{whatsapp` (أي صيغة)`, password}` |
| POST | `/api/cook/logout` | |
| GET | `/api/cook/me` | `{id, name, whatsapp, area, bio, photoUrl, profileUrl, services[], servedAreas[], subscription{status,plan,startDate,expiryDate}, stats{views_total, views_30d, likes, impressions_total, impressions_30d, whatsapp_total, whatsapp_30d, rating}, photos[{id,url,caption,hidden}], maxPhotos}` — **بلا شكاوي وبلا إنذارات** |
| PATCH | `/api/cook/me` | أي من `{bio, photo, services[], servedAreaIds[], lat+lng, areaLabel}` ← me. الاسم والرقم للإدارة بس |
| POST | `/api/cook/password` | `{current, next ≥ 6}` |
| POST | `/api/cook/photos` | `{data: "data:image/jpeg;base64,...", caption?}` (حد أقصى ~400 KB) ← me |
| DELETE | `/api/cook/photos/:id` | ← me |
| GET | `/api/cook/photo`, `/api/cook/photos/:id.jpg` | صورتها وصورها (حتى المخفية) |

### الإدارة (كوكي `st_admin`، 12 ساعة)
| | المسار | ملاحظات |
|---|---|---|
| POST | `/api/admin/login` | `{username, password}` — الاسم مش حسّاس للأحرف |
| GET | `/api/admin/stats` | يتضمّن `new_feedback` |
| GET | `/api/admin/cooks?filter=&q=&limit=50&offset=0` | filter: pending/active/expired/suspended/rejected/no_subscription/all — بصفحات: `{cooks[], total, offset, limit, hasMore}`، كل سطر فيه `rating, warnings, openFeedback` |
| GET/PATCH | `/api/admin/cooks/:id` | PATCH: `{fullName, whatsapp, areaId, servedAreaIds[], services[], bio, adminNotes, photo, lat, lng}` |
| POST | `/api/admin/cooks` | نفس الحقول + `activate?{plan, startDate}` |
| POST | `/api/admin/cooks/:id/approve\|reject` | |
| POST | `/api/admin/cooks/:id/password` | `{password?}` ← `{password, whatsappUrl}` (رسالة للست فيها معلومات الدخول) |
| POST | `/api/admin/cooks/:id/warnings` | `{message, feedbackId?}` ← `{whatsappUrl, cook}`، وبيقفل الشكوى |
| POST | `/api/admin/cooks/:id/subscription/activate\|renew\|suspend\|expire` | |
| PATCH | `/api/admin/cooks/:id/subscription` | تعديل التواريخ والمدة والدفع |
| GET | `/api/admin/feedback?status=new\|resolved\|all` | |
| PATCH | `/api/admin/feedback/:id` | `{status?, adminNote?}` |
| DELETE | `/api/admin/photos/:id` | |
| POST | `/api/admin/areas` | `{nameAr, nameEn?, district, lat?, lng?}` |
| POST | `/api/admin/areas/import` | `{country: 'LB'}` ← 202، استيراد كل بلدات البلد من OpenStreetMap بالخلفية |
| GET | `/api/admin/areas/import?country=LB` | `{state: never\|running\|done\|failed, found, added, totalAreas}` |

---

## 5. رسائل WhatsApp

النصوص كلها بـ `locales/ar.json` تحت `wa.*`:
- `customerMessage` — من الزبونة للست: الطلب + المنطقة.
- `adminApplication` — طلب اشتراك للإدارة: الاسم، الرقم، المنطقة، رابط الموقع على الخريطة، «يوصل إلى»، الخدمات، المدة.
- `cookLogin` — معلومات دخول الست.
- `warning` — إنذار للست (الإدارة بتعدّلو قبل ما تبعتو).

الروابط `https://wa.me/<رقم>?text=<نص>`. على Android، إذا في WhatsApp وWhatsApp Business، التلفون بيفتح التطبيق الافتراضي.

---

## 6. تحديد الموقع (بالواجهة)

- الطبّاخ: `watchPosition` بدقة عالية لحد 15 ثانية، بياخد أدق قراءة وبيوقف عند ± 25 م. بيعرض الدقة + رابط Google Maps، وبينبّه إذا الدقة > 100 م. الإحداثيات بتنحفظ لـ 4 خانات عشرية.
- الزبون: نفس الطريقة لحد 8 ثواني و± 50 م، مقرّبة لـ 3 خانات (~100 م) بالمتصفح، و~1 كم بالقاعدة.
- كل ملفات JS/CSS بروابط فيها `?v=<رقم>` + ETag + gzip، لتنزل التحديثات فوراً وبحجم أصغر.
- الصور: إذا `S3_*` مضبوطة، الروابط بتكون مباشرة على الـ CDN، و`/media/...` بترجّع تحويل 302.

## 7. ملاحظات لتطبيق الموبايل

- نفس الـ API بلا أي تغيير. للكوكيز استعملي مكتبة HTTP بتحفظها (أو WebView).
- الصور: صغّريها قبل الرفع (الموقع بيعمل 1000px بجودة 0.8).
- الإشعارات (Push) مش موجودة بعد. الست بتستلم الطلبات عالـ WhatsApp.
- الموقع فيه manifest، فالست بتقدر تزيد `/account` عشاشة تلفونها كتطبيق.


## إضافات النسخة 3.1

| | المسار | الوصف |
|---|---|---|
| GET | `/api/cooks/nearby?lat=&lng=` | الطبّاخون الذين يوصلون إلى الموقع، الأقرب أولاً (نفس مطابقة `/api/search` دون إنشاء طلب) ← `{area, cooks[CookCard + distanceKm]}` |
| GET | `/api/cooks/by-region` | `{regions[{key, name, cooks[CookCard]}]}` حسب المحافظة (من قضاء بلدة الطبّاخ) |
| GET | `/api/dishes?offset=&limit=10` | `{dishes[{id, photoUrl, caption, cookId, cookName, area, profileUrl}], offset, hasMore}` |
| GET | `/api/config` | أُضيف `site: {announcement, sections{nearby, regions, dishes, nameSearch, cooksSlider}, brand}` |
| POST | `/api/admin/cooks/:id/hide` و`/unhide` | إخفاء/إظهار الحساب من الموقع كلّه (`cooks.is_hidden`) |
| DELETE | `/api/admin/cooks/:id` | حذف نهائي (متسلسل على كل الجداول + ملفات التخزين) |
| PATCH | `/api/admin/reviews/:id` و`/api/admin/photos/:id` | `{hidden: true\|false}` |
| GET/PUT | `/api/admin/settings` | `{brandName, brandNameEn, announcement, adminWhatsapp, sections{...}}` (محفوظة في `app_meta.site_settings`) |

**قاعدة الظهور:** `approved` + `is_hidden = 0` + اشتراك فعّال.


## إضافات النسخة 4.0

| | المسار | الوصف |
|---|---|---|
| GET | `/api/config?country=XX` | إعدادات حسب بلد الزائر: `country{code, lang, currency…}`, `billing{currency}`, `countryTimezones`, `site{prices{cook,restaurant}, trial, limits, sections}` |
| GET | `/api/areas/around?lat&lng` | + `country`, `region` |
| POST | `/api/cook-applications` | + `kind: cook\|restaurant`, `specialty` (مطعم). البلد من الـ GPS تلقائياً |
| GET | `/api/cooks/nearby?lat&lng&type=cook\|restaurant` | + `country` |
| GET | `/api/cooks/by-region?country=XX&type=` | |
| POST | `/api/cooks/:id/request` | للمطاعم: `items[{id, qty}]` + `text` اختياري ← `type: order\|contact` |
| GET | `/api/feed` | + `restaurantPhotos[]` |
| GET | `/api/banners` · `/media/banners/:id.jpg` | الإعلانات الظاهرة |
| GET | `/api/stats/public` | العدّاد العالمي (`enabled:false` إن كان مطفأً) |
| POST/PATCH/DELETE | `/api/cook/menu[/:id]` | منيو المطعم |
| GET/POST | `/api/cook/support` | محادثة المشترك مع الإدارة |
| GET | `/api/admin/cooks?kind=&country=` | |
| POST | `/api/admin/cooks/:id/subscription/trial` | مدة تجريبية (الأيام من الإعدادات) |
| GET/POST | `/api/admin/support[/:cookId]` | المحادثات والردّ |
| GET/POST/PATCH/DELETE | `/api/admin/banners[/:id]` | الإعلانات (الأماكن: home_top, home_middle, home_bottom, results_top, browse_top, cook_page, join_top) |
| DELETE | `/api/admin/menu/:id` | حذف طبق |

**جداول جديدة:** `geo_cells`, `menu_items`, `support_messages`, `banners`. **أعمدة:** `cooks.kind/specialty/region_*`, `service_areas.country`, `subscriptions.currency/amount/is_trial`.

## إضافات النسخة 4.4 (الموقع والمسافات)
| | | |
|---|---|---|
| POST | `/api/search` | `location: {type:'gps', lat, lng, accuracy?}` — دقة > 1500 م ← 422 `location_inaccurate`. كل نتيجة فيها `distanceM` (أمتار) + `distanceKm` |
| POST | `/api/cooks/:id/request` | + `accuracy?` |
| GET | `/api/cooks/nearby` | النتائج فيها `distanceM` |
| POST | `/api/cook-applications` | + `accuracy` (≤ 150 م) و`locationAt` (ms، ≤ 10 دقائق) ← وإلا 422 `location_inaccurate` / `location_stale` |
| PATCH | `/api/cook/me` | تحديث الموقع: نفس شروط الدقة والحداثة |
| GET | `/api/config` | + `geoAttribution` |

**أعمدة جديدة:** `cooks.location_accuracy_m, location_at, addr_city, addr_district, addr_locality` · `request_impressions.distance_m` · `geo_cells.city, district, locality` · قيود Postgres على خطوط الطول والعرض (`cooks_latlng_chk`, `service_areas_latlng_chk`).
