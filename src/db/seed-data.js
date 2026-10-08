// Reference data. Village coordinates are approximate centres; admins can add more villages from the dashboard.
// Bump SEED_VERSION whenever this list changes so the server re-seeds on boot.
export const SEED_VERSION = '2';
export const SERVICE_TYPES = ['home_cooking', 'pastries', 'sweets', 'mouneh', 'mezze', 'feasts'];
export const PLANS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
export const MAX_PHOTOS_PER_COOK = 12;

// Lebanon's 26 districts (qada')
export const DISTRICTS = {
  beirut: { ar: 'بيروت', en: 'Beirut' },
  baabda: { ar: 'بعبدا', en: 'Baabda' },
  metn: { ar: 'المتن', en: 'Metn' },
  keserwan: { ar: 'كسروان', en: 'Keserwan' },
  jbeil: { ar: 'جبيل', en: 'Jbeil' },
  aley: { ar: 'عاليه', en: 'Aley' },
  chouf: { ar: 'الشوف', en: 'Chouf' },
  tripoli: { ar: 'طرابلس', en: 'Tripoli' },
  minieh_danniyeh: { ar: 'المنية - الضنية', en: 'Minieh-Danniyeh' },
  zgharta: { ar: 'زغرتا', en: 'Zgharta' },
  koura: { ar: 'الكورة', en: 'Koura' },
  batroun: { ar: 'البترون', en: 'Batroun' },
  bcharre: { ar: 'بشري', en: 'Bcharre' },
  akkar: { ar: 'عكار', en: 'Akkar' },
  zahle: { ar: 'زحلة', en: 'Zahle' },
  west_beqaa: { ar: 'البقاع الغربي', en: 'West Beqaa' },
  rashaya: { ar: 'راشيا', en: 'Rashaya' },
  baalbek: { ar: 'بعلبك', en: 'Baalbek' },
  hermel: { ar: 'الهرمل', en: 'Hermel' },
  saida: { ar: 'صيدا', en: 'Saida' },
  tyre: { ar: 'صور', en: 'Tyre' },
  jezzine: { ar: 'جزين', en: 'Jezzine' },
  nabatieh: { ar: 'النبطية', en: 'Nabatieh' },
  bint_jbeil: { ar: 'بنت جبيل', en: 'Bint Jbeil' },
  marjayoun: { ar: 'مرجعيون', en: 'Marjayoun' },
  hasbaya: { ar: 'حاصبيا', en: 'Hasbaya' },
};

// district|slug|Arabic|English|lat|lng
const RAW = `
beirut|beirut|بيروت|Beirut|33.8938|35.5018
beirut|achrafieh|الأشرفية|Achrafieh|33.8886|35.5200
beirut|hamra|الحمرا|Hamra|33.8959|35.4824
beirut|mazraa|المزرعة|Mazraa|33.8780|35.4990
beirut|tariq-jdideh|الطريق الجديدة|Tariq El Jdideh|33.8700|35.4930
baabda|baabda|بعبدا|Baabda|33.8339|35.5442
baabda|dahieh|الضاحية|Dahieh|33.8530|35.5130
baabda|chiyah|الشياح|Chiyah|33.8590|35.5170
baabda|hadath|الحدث|Hadath|33.8330|35.5330
baabda|furn-el-chebbak|فرن الشباك|Furn El Chebbak|33.8680|35.5320
baabda|hazmieh|الحازمية|Hazmieh|33.8540|35.5420
baabda|burj-barajneh|برج البراجنة|Burj El Barajneh|33.8460|35.5010
baabda|ghobeiry|الغبيري|Ghobeiry|33.8600|35.5040
baabda|kfarchima|كفرشيما|Kfarchima|33.8200|35.5270
baabda|falougha|فالوغا|Falougha|33.8330|35.7200
metn|jdeideh|الجديدة|Jdeideh|33.8920|35.5620
metn|antelias|أنطلياس|Antelias|33.9150|35.5900
metn|dbayeh|ضبية|Dbayeh|33.9380|35.5890
metn|zalka|الزلقا|Zalka|33.9000|35.5700
metn|sin-el-fil|سن الفيل|Sin El Fil|33.8750|35.5400
metn|bourj-hammoud|برج حمود|Bourj Hammoud|33.8930|35.5390
metn|dekwaneh|الدكوانة|Dekwaneh|33.8800|35.5500
metn|mansourieh|المنصورية|Mansourieh|33.8650|35.5670
metn|fanar|الفنار|Fanar|33.8830|35.5760
metn|rabieh|الرابية|Rabieh|33.9230|35.5920
metn|broummana|برمانا|Broummana|33.8800|35.6300
metn|beit-mery|بيت مري|Beit Mery|33.8580|35.5980
metn|bikfaya|بكفيا|Bikfaya|33.9200|35.6800
metn|baabdat|بعبدات|Baabdat|33.8950|35.6720
metn|beit-chabab|بيت شباب|Beit Chabab|33.9300|35.6700
metn|dhour-choueir|ضهور الشوير|Dhour El Choueir|33.9120|35.7080
metn|bteghrine|بتغرين|Bteghrine|33.9180|35.7590
metn|baskinta|بسكنتا|Baskinta|33.9460|35.8030
keserwan|jounieh|جونية|Jounieh|33.9808|35.6178
keserwan|zouk-mosbeh|ذوق مصبح|Zouk Mosbeh|33.9500|35.6100
keserwan|zouk-mikael|ذوق مكايل|Zouk Mikael|33.9700|35.6150
keserwan|jeita|جعيتا|Jeita|33.9430|35.6420
keserwan|harissa|حريصا|Harissa|33.9800|35.6480
keserwan|ballouneh|بلونة|Ballouneh|33.9780|35.6600
keserwan|ghazir|غزير|Ghazir|34.0180|35.6620
keserwan|tabarja|طبرجا|Tabarja|34.0280|35.6320
keserwan|ghosta|غوسطا|Ghosta|33.9950|35.6790
keserwan|ajaltoun|عجلتون|Ajaltoun|33.9950|35.6990
keserwan|reifoun|ريفون|Reifoun|33.9990|35.7150
keserwan|faitroun|فيطرون|Faitroun|33.9990|35.7270
keserwan|kfardebian|كفرذبيان|Kfardebian|33.9990|35.7910
keserwan|faraya|فاريا|Faraya|34.0100|35.8200
jbeil|jbeil|جبيل|Byblos|34.1230|35.6519
jbeil|amchit|عمشيت|Amchit|34.1480|35.6500
jbeil|halat|حالات|Halat|34.0850|35.6450
jbeil|jaj|جاج|Jaj|34.1590|35.7300
jbeil|ehmej|إهمج|Ehmej|34.1110|35.7640
jbeil|qartaba|قرطبا|Qartaba|34.0960|35.8480
aley|aley|عاليه|Aley|33.8100|35.6000
aley|bhamdoun|بحمدون|Bhamdoun|33.8000|35.6500
aley|sofar|صوفر|Sofar|33.8050|35.6980
aley|souk-el-gharb|سوق الغرب|Souk El Gharb|33.8100|35.5800
aley|choueifat|الشويفات|Choueifat|33.8090|35.5100
aley|khaldeh|خلدة|Khaldeh|33.7870|35.4880
aley|aramoun|عرمون|Aramoun|33.7730|35.5100
aley|bchamoun|بشامون|Bchamoun|33.7830|35.5350
aley|baissour|بيصور|Baissour|33.7580|35.5790
chouf|beiteddine|بيت الدين|Beiteddine|33.6950|35.5800
chouf|deir-el-qamar|دير القمر|Deir El Qamar|33.6960|35.5640
chouf|damour|الدامور|Damour|33.7300|35.4600
chouf|naameh|الناعمة|Naameh|33.7560|35.4730
chouf|baakline|بعقلين|Baakline|33.6800|35.5580
chouf|moukhtara|المختارة|Moukhtara|33.6560|35.5980
chouf|barouk|الباروك|Barouk|33.7050|35.6750
chouf|maasser-chouf|معاصر الشوف|Maasser El Chouf|33.6700|35.6780
chouf|chhim|شحيم|Chhim|33.6200|35.4900
chouf|barja|برجا|Barja|33.6480|35.4450
chouf|jiyeh|الجية|Jiyeh|33.6550|35.4200
tripoli|tripoli|طرابلس|Tripoli|34.4367|35.8497
tripoli|mina|الميناء|El Mina|34.4500|35.8200
tripoli|qalamoun|القلمون|Qalamoun|34.3900|35.8050
minieh_danniyeh|minieh|المنية|Minieh|34.4900|35.9300
minieh_danniyeh|beddawi|البداوي|Beddawi|34.4550|35.8650
minieh_danniyeh|sir-danniyeh|سير الضنية|Sir El Danniyeh|34.3900|36.0300
minieh_danniyeh|bakhoun|بخعون|Bakhoun|34.4000|35.9900
zgharta|zgharta|زغرتا|Zgharta|34.3980|35.8950
zgharta|ehden|إهدن|Ehden|34.2922|35.9711
zgharta|miziara|مزيارة|Miziara|34.3350|35.9380
zgharta|arbet-kozhaya|عربة قزحيا|Arbet Kozhaya|34.2950|35.9256
koura|amioun|أميون|Amioun|34.3000|35.8100
koura|kousba|كوسبا|Kousba|34.2980|35.8490
koura|enfeh|أنفه|Enfeh|34.3530|35.7300
koura|bishmizzine|بشمزين|Bishmizzine|34.3150|35.7970
batroun|batroun|البترون|Batroun|34.2553|35.6581
batroun|chekka|شكا|Chekka|34.3300|35.7300
batroun|selaata|سلعاتا|Selaata|34.2830|35.6620
batroun|douma|دوما|Douma|34.2000|35.8430
batroun|tannourine|تنورين|Tannourine|34.2100|35.9200
bcharre|bcharre|بشري|Bcharre|34.2511|36.0117
bcharre|hasroun|حصرون|Hasroun|34.2380|35.9820
bcharre|hadath-jebbeh|حدث الجبة|Hadath El Jebbeh|34.2280|35.9590
bcharre|bqaa-kafra|بقاعكفرا|Bqaa Kafra|34.2570|36.0310
akkar|halba|حلبا|Halba|34.5428|36.0797
akkar|qoubaiyat|القبيات|Qoubaiyat|34.5690|36.2780
akkar|bebnine|ببنين|Bebnine|34.5000|35.9880
akkar|mhammara|المحمرة|Mhammara|34.5180|35.9850
akkar|qlayaat|القليعات|Qlayaat|34.5850|36.0100
akkar|akkar-atika|عكار العتيقة|Akkar El Atika|34.5300|36.2300
akkar|bireh|البيرة|Bireh|34.5660|36.1880
akkar|andaket|عندقت|Andaket|34.6150|36.2500
zahle|zahle|زحلة|Zahle|33.8463|35.9020
zahle|chtaura|شتورا|Chtaura|33.8156|35.8531
zahle|saadnayel|سعدنايل|Saadnayel|33.8240|35.8850
zahle|taalabaya|تعلبايا|Taalabaya|33.8220|35.8780
zahle|jdita|جديتا|Jdita|33.8200|35.8420
zahle|qab-elias|قب الياس|Qab Elias|33.7900|35.8250
zahle|taanayel|تعنايل|Taanayel|33.7880|35.8710
zahle|bar-elias|برالياس|Bar Elias|33.7750|35.9000
zahle|kfarzabad|كفرزبد|Kfarzabad|33.7600|35.9450
zahle|anjar|عنجر|Anjar|33.7300|35.9300
zahle|majdel-anjar|مجدل عنجر|Majdel Anjar|33.7070|35.9040
zahle|ferzol|الفرزل|Ferzol|33.8680|35.9420
zahle|ablah|أبلح|Ablah|33.8790|35.9540
zahle|ali-nahri|علي النهري|Ali El Nahri|33.8350|35.9950
zahle|riyaq|رياق|Riyaq|33.8500|36.0100
west_beqaa|joub-jannine|جب جنين|Joub Jannine|33.6300|35.7800
west_beqaa|marj|المرج|Marj|33.7300|35.8700
west_beqaa|ghazze|غزة|Ghazze|33.6700|35.8400
west_beqaa|kamed-lawz|كامد اللوز|Kamed El Lawz|33.6230|35.8160
west_beqaa|khirbet-qanafar|خربة قنافار|Khirbet Qanafar|33.6450|35.7650
west_beqaa|saghbine|صغبين|Saghbine|33.5990|35.7040
west_beqaa|qaraoun|القرعون|Qaraoun|33.5700|35.7200
west_beqaa|sohmor|سحمر|Sohmor|33.5170|35.6960
west_beqaa|machghara|مشغرة|Machghara|33.5320|35.6520
rashaya|rashaya|راشيا|Rashaya|33.5000|35.8430
rashaya|kfarmechki|كفرمشكي|Kfarmechki|33.5150|35.8650
baalbek|baalbek|بعلبك|Baalbek|34.0047|36.2110
baalbek|douris|دورس|Douris|33.9900|36.1900
baalbek|iaat|إيعات|Iaat|34.0350|36.1650
baalbek|brital|بريتال|Brital|33.9550|36.2400
baalbek|bednayel|بدنايل|Bednayel|33.9400|36.1000
baalbek|temnin|تمنين|Temnin|33.9150|36.0550
baalbek|chmestar|شمسطار|Chmestar|33.9580|36.0600
baalbek|nabi-chit|النبي شيت|Nabi Chit|33.8850|36.1100
baalbek|deir-el-ahmar|دير الأحمر|Deir El Ahmar|34.1250|36.1300
baalbek|laboueh|اللبوة|Laboueh|34.1950|36.3500
baalbek|ras-baalbek|رأس بعلبك|Ras Baalbek|34.2600|36.4200
baalbek|qaa|القاع|Qaa|34.3450|36.4750
hermel|hermel|الهرمل|Hermel|34.3943|36.3848
saida|saida|صيدا|Saida|33.5571|35.3729
saida|haret-saida|حارة صيدا|Haret Saida|33.5500|35.3850
saida|abra|عبرا|Abra|33.5580|35.3970
saida|maghdoucheh|مغدوشة|Maghdoucheh|33.5220|35.4000
saida|ghazieh|الغازية|Ghazieh|33.5150|35.3670
saida|anqoun|عنقون|Anqoun|33.5000|35.4300
saida|sarafand|الصرفند|Sarafand|33.4520|35.2980
jezzine|jezzine|جزين|Jezzine|33.5439|35.5847
jezzine|roum|روم|Roum|33.5550|35.5200
jezzine|bkassine|بكاسين|Bkassine|33.5620|35.5730
tyre|tyre|صور|Tyre|33.2704|35.2038
tyre|burj-shemali|برج الشمالي|Burj El Shemali|33.2700|35.2400
tyre|abbassieh|العباسية|Abbassieh|33.2930|35.2400
tyre|bazouriyeh|البازورية|Bazouriyeh|33.2560|35.2700
tyre|maarakeh|معركة|Maarakeh|33.2710|35.3000
tyre|jouaya|جويا|Jouaya|33.2580|35.3300
tyre|qana|قانا|Qana|33.2090|35.2990
tyre|naqoura|الناقورة|Naqoura|33.1180|35.1390
nabatieh|nabatieh|النبطية|Nabatieh|33.3789|35.4839
nabatieh|kfar-roummane|كفررمان|Kfar Roummane|33.3700|35.5100
nabatieh|habboush|حبوش|Habboush|33.4070|35.4800
nabatieh|doueir|الدوير|Doueir|33.3600|35.4500
nabatieh|jbchit|جبشيت|Jbchit|33.3570|35.4200
nabatieh|arnoun|أرنون|Arnoun|33.3280|35.5190
bint_jbeil|bint-jbeil|بنت جبيل|Bint Jbeil|33.1203|35.4333
bint_jbeil|tebnine|تبنين|Tebnine|33.1850|35.4130
bint_jbeil|rmeish|رميش|Rmeish|33.0800|35.3700
bint_jbeil|qaouzah|القوزح|Qaouzah|33.1214|35.3394
marjayoun|marjayoun|مرجعيون|Marjayoun|33.3600|35.5900
marjayoun|khiam|الخيام|Khiam|33.3290|35.6120
marjayoun|qlayaa|القليعة|Qlayaa|33.3350|35.5650
marjayoun|kfarkela|كفركلا|Kfarkela|33.2860|35.5720
hasbaya|hasbaya|حاصبيا|Hasbaya|33.3978|35.6853
hasbaya|kawkaba|كوكبا|Kawkaba|33.4000|35.6400
hasbaya|kfarchouba|كفرشوبا|Kfarchouba|33.3650|35.7100
hasbaya|chebaa|شبعا|Chebaa|33.3480|35.7340
`;

export const AREAS = RAW.trim().split('\n').map((line) => {
  const [district, slug, ar, en, lat, lng] = line.split('|');
  return { district, slug, ar, en, lat: Number(lat), lng: Number(lng) };
});

// Governorates (محافظات) and their districts — used to browse cooks by region. Per country.
export const GOVERNORATES = {
  LB: [
    { key: 'beirut', ar: 'بيروت', en: 'Beirut', districts: ['beirut'] },
    { key: 'mount_lebanon', ar: 'جبل لبنان', en: 'Mount Lebanon', districts: ['baabda', 'metn', 'keserwan', 'jbeil', 'aley', 'chouf'] },
    { key: 'north', ar: 'الشمال', en: 'North', districts: ['tripoli', 'minieh_danniyeh', 'zgharta', 'koura', 'batroun', 'bcharre'] },
    { key: 'akkar', ar: 'عكار', en: 'Akkar', districts: ['akkar'] },
    { key: 'beqaa', ar: 'البقاع', en: 'Beqaa', districts: ['zahle', 'west_beqaa', 'rashaya'] },
    { key: 'baalbek_hermel', ar: 'بعلبك - الهرمل', en: 'Baalbek-Hermel', districts: ['baalbek', 'hermel'] },
    { key: 'south', ar: 'الجنوب', en: 'South', districts: ['saida', 'tyre', 'jezzine'] },
    { key: 'nabatieh', ar: 'النبطية', en: 'Nabatieh', districts: ['nabatieh', 'bint_jbeil', 'marjayoun', 'hasbaya'] },
  ],
};
