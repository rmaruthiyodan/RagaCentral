/* ==================================================================
 * A starter catalogue: the standard beginner-to-varnam repertoire,
 * taken from the lesson archive Ratish supplied.
 *
 * Loaded once from the Songs page. Idempotent — a song already in the
 * catalogue with the same title and raga is left alone, so pressing the
 * button twice adds nothing and edits are never overwritten.
 *
 * Ragas for the varisai exercises are Mayamalavagowla because that is
 * what they are taught in; the teacher can change any of it in the app.
 * ================================================================== */

export interface SeedSong {
  title: string;
  raga: string | null;
  taala: string | null;
  composer: string | null;
}

export interface SeedGroup {
  name: string;
  songs: SeedSong[];
}

export const STARTER_CATALOGUE: SeedGroup[] = [
  {
    name: 'Sarali Varisai',
    songs: [
      { title: 'Sarali 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 05', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 06', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 07', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 08', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 09', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 10', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 11', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 12', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 13', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Sarali 14', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Janta Varisai',
    songs: [
      { title: 'Janta 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 05', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 06', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 07', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 08', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Janta 09', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Dhatu Varisai',
    songs: [
      { title: 'Dhatu Varisai 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 05', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 06', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 07', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 08', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 09', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Varisai 10', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Janta Varisai 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Janta Varisai 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Janta Varisai 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Dhatu Janta Varisai 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Melsthayi (Thara Sthayi) Varisai',
    songs: [
      { title: 'Thara Sthayi 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Thara Sthayi 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Thara Sthayi 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Thara Sthayi 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Thara Sthayi 05', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Mandhra Sthayi Varisai',
    songs: [
      { title: 'Mandhra Sthayi 01', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Mandhra Sthayi 02', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Mandhra Sthayi 03', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
      { title: 'Mandhra Sthayi 04', raga: 'Mayamalavagowla', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Alankarams',
    songs: [
      { title: 'Alankaram — Dhruva Talam', raga: 'Mayamalavagowla', taala: 'Dhruva Talam', composer: null },
      { title: 'Alankaram — Matya Talam', raga: 'Mayamalavagowla', taala: 'Matya Talam', composer: null },
      { title: 'Alankaram — Rupaka Talam', raga: 'Mayamalavagowla', taala: 'Rupaka Talam', composer: null },
      { title: 'Alankaram — Eka Talam', raga: 'Mayamalavagowla', taala: 'Eka Talam', composer: null },
      { title: 'Alankaram — Triputa Talam', raga: 'Mayamalavagowla', taala: 'Triputa Talam', composer: null },
      { title: 'Alankaram — Ata Talam', raga: 'Mayamalavagowla', taala: 'Ata Talam', composer: null },
      { title: 'Alankaram — Jhumpa Talam', raga: 'Mayamalavagowla', taala: 'Jhumpa Talam', composer: null },
    ],
  },
  {
    name: 'Geethams',
    songs: [
      { title: 'Analekara', raga: 'Shuddha Saveri', taala: 'Triputa', composer: null },
      { title: 'Kamalajaathala', raga: 'Kalyani', taala: 'Triputa', composer: null },
      { title: 'Keraya Neeranu', raga: 'Malahari', taala: 'Triputa', composer: 'Purandaradasa' },
      { title: 'Kunda Goura', raga: 'Malahari', taala: 'Rupakam', composer: 'Purandaradasa' },
      { title: 'Lambodara', raga: 'Malahari', taala: 'Rupakam', composer: 'Purandaradasa' },
      { title: 'Padumanabha', raga: 'Malahari', taala: 'Triputa', composer: 'Purandaradasa' },
      { title: 'Rere Sriramachandra', raga: 'Arabhi', taala: 'Triputa', composer: null },
      { title: 'Sri Ramachandra', raga: 'Bhairavi', taala: 'Dhruva Talam', composer: null },
      { title: 'Vara Veena', raga: 'Mohanam', taala: 'Rupakam', composer: null },
    ],
  },
  {
    name: 'Swarajatis',
    songs: [
      { title: 'Raara Venugopa', raga: 'Bilahari', taala: 'Adi', composer: null },
      { title: 'Samba Shivayanave', raga: 'Khamas', taala: 'Adi', composer: null },
    ],
  },
  {
    name: 'Varnams — Adi tala',
    songs: [
      { title: 'Devar Munivar', raga: 'Shanmukhapriya', taala: 'Adi', composer: 'Lalgudi Jayaraman' },
      { title: 'Entho Prema', raga: 'Surutti', taala: 'Adi', composer: 'Pallavi Gopalaiyer' },
      { title: 'Era Napai', raga: 'Thodi', taala: 'Adi', composer: 'Patnam Subramanya Iyer' },
      { title: 'Evvari Bodhana', raga: 'Abhogi', taala: 'Adi', composer: 'Patnam Subramania Iyer' },
      { title: 'Innam En Manam', raga: 'Charukesi', taala: 'Adi', composer: 'Lalgudi Jayaraman' },
      { title: 'Intha Chalamu', raga: 'Begada', taala: 'Adi', composer: 'Veenai Kuppaiyer' },
      { title: 'Intha Chouka', raga: 'Bilahari', taala: 'Adi', composer: 'Veenai Kuppaiyer' },
      { title: 'Intha Modi', raga: 'Saaranga', taala: 'Adi', composer: 'Tiruvotriyur Thyagaiyer' },
      { title: 'Jalajakshi', raga: 'Hamsadhwani', taala: 'Adi', composer: 'Manambuchavadi Venkatasubbaiyer' },
      { title: 'Karunimpa', raga: 'Sahana', taala: 'Adi', composer: 'Tiruvotriyur Thiyagaiyer' },
      { title: 'Ninnukori', raga: 'Mohanam', taala: 'Adi', composer: 'Ramnad Srinivasa Iyengar' },
      { title: 'Ninnukori', raga: 'Vasanta', taala: 'Adi', composer: 'Tacchur Singarachari' },
      { title: 'Nive Gatiyani', raga: 'Nalinakanthi', taala: 'Adi', composer: 'Lalgudi Jayaraman' },
      { title: 'Sami Dayajuda', raga: 'Kedaragowla', taala: 'Adi', composer: 'Tiruvottriyur Thiagayyer' },
      { title: 'Sami Ninne', raga: 'Shankarabharanam', taala: 'Adi', composer: 'Veenai Kuppaiyer' },
      { title: 'Sami Ninne', raga: 'Sri Ragam', taala: 'Adi', composer: 'Karur Devudu Iyer' },
      { title: 'Sarasuda Ninne', raga: 'Saveri', taala: 'Adi', composer: 'Kothavaasal Venkatarama Iyer' },
      { title: 'Tharuni Ninnu', raga: 'Kambodhi', taala: 'Adi', composer: 'Violin Ponnuswamy' },
      { title: 'Valachi Vacchi', raga: 'Navaragamalika', taala: 'Adi', composer: 'Patnam Subramanya Iyer' },
      { title: 'Vanajakshiro', raga: 'Kalyani', taala: 'Adi', composer: 'Ramnad Srinivasa Iyengar' },
    ],
  },
  {
    name: 'Varnams — Ata tala',
    songs: [
      { title: 'Chalamela', raga: 'Shankarabharanam', taala: 'Ata', composer: 'Swati Tirunal' },
      { title: 'Chalamela', raga: 'Durbar', taala: 'Ata', composer: 'Thiruvotriyur Thiagaiyyer' },
      { title: 'Nera Nammithi', raga: 'Kanada', taala: 'Ata', composer: 'Ramnad Srinivasa Iyengar' },
      { title: 'Sarasija Nabha', raga: 'Kambodhi', taala: 'Ata', composer: 'Vadivelu' },
      { title: 'Vanajaksha', raga: 'Kalyani', taala: 'Ata', composer: 'Pallavi Gopala Iyer' },
      { title: 'Vanajaksha', raga: 'Reethigowlai', taala: 'Ata', composer: 'Veenai Kuppaiyer' },
      { title: 'Viriboni', raga: 'Bhairavi', taala: 'Ata', composer: 'Pacchimirium Adiappaiyer' },
    ],
  },
];

export const STARTER_COUNT = 91;
