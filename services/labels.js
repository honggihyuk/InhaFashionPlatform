// H&M 영문 분류명 → 화면 표시용 한글 라벨
const KO = {
  Ladieswear: '여성', Menswear: '남성', Divided: '디바이디드', 'Baby/Children': '아동', Sport: '스포츠',
  'Garment Upper body': '상의', 'Garment Lower body': '하의', 'Garment Full body': '원피스·점프수트',
  Underwear: '언더웨어', Swimwear: '스윔웨어', 'Socks & Tights': '양말·타이츠', Shoes: '신발', Accessories: '액세서리',
  Nightwear: '나이트웨어', Cosmetic: '코스메틱', Bags: '가방', Items: '잡화', Furniture: '리빙', Stationery: '문구',
  'Garment and Shoe care': '의류 관리', Fun: '기타', Unknown: '미분류', Other: '기타',
  Black: '블랙', White: '화이트', Blue: '블루', Grey: '그레이', Beige: '베이지', Pink: '핑크', Red: '레드',
  Green: '그린', 'Khaki green': '카키', Brown: '브라운', Yellow: '옐로', Orange: '오렌지', Metal: '메탈',
  Turquoise: '터키석', 'Lilac Purple': '라일락', 'Mole': '몰', 'Yellowish Green': '연두', 'Bluish Green': '청록',
  'undefined': '기타', Unknown_colour: '기타',
};

function ko(name) {
  return KO[name] || name;
}

module.exports = { ko };
