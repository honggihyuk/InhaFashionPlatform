// 상품 이미지가 없을 때 사용할 SVG 일러스트.
// H&M 원본 이미지(images/0xx/*.jpg)를 public/images/articles 에 넣으면 그 이미지가 우선 사용됩니다.

const COLOURS = {
  Black: '#1b1b1b', White: '#fbfbf8', 'Off White': '#efe9de', 'Dark Blue': '#1f2d4d', Blue: '#3c5f93',
  'Light Blue': '#9fbfdd', Grey: '#8c8c8c', 'Dark Grey': '#4a4a4a', 'Light Grey': '#c9c9c9', Beige: '#cdb79a',
  'Light Beige': '#e6d8c3', Red: '#b3262e', 'Dark Red': '#6e1420', Pink: '#df9fb0', 'Light Pink': '#f1cdd4',
  'Dark Pink': '#a8476a', 'Dark Green': '#24412b', 'Greenish Khaki': '#7d7b55', 'Yellowish Brown': '#9a6b3c',
  Yellow: '#e6c34a', Orange: '#d97a35', Green: '#4c7a4e', Brown: '#5d3d29', Khaki: '#8c8257',
};

const SHAPES = {
  top: 'M70 40 L100 28 Q120 44 140 28 L170 40 L196 92 L170 104 L160 84 L160 210 L80 210 L80 84 L70 104 L44 92 Z',
  longsleeve: 'M70 40 L100 28 Q120 44 140 28 L170 40 L200 190 L178 196 L160 92 L160 210 L80 210 L80 92 L62 196 L40 190 Z',
  vest: 'M88 30 L100 30 Q120 62 140 30 L152 30 L156 80 L164 210 L76 210 L84 80 Z',
  outer: 'M68 36 L104 26 L120 70 L136 26 L172 36 L204 200 L180 206 L164 100 L164 220 L76 220 L76 100 L60 206 L36 200 Z',
  trousers: 'M78 30 L162 30 L172 220 L132 220 L120 96 L108 220 L68 220 Z',
  shorts: 'M76 50 L164 50 L176 150 L130 156 L120 104 L110 156 L64 150 Z',
  skirt: 'M88 40 L152 40 L182 200 Q120 214 58 200 Z',
  dress: 'M92 26 L104 26 Q120 46 136 26 L148 26 L150 80 L186 216 Q120 228 54 216 L90 80 Z',
  swim: 'M84 50 L100 50 Q120 82 140 50 L156 50 L150 120 Q160 160 150 190 L120 176 L90 190 Q80 160 90 120 Z',
  socks: 'M100 30 L136 30 L136 150 L176 178 Q186 196 168 204 L112 196 Q96 190 100 170 Z',
  shoe: 'M40 150 Q44 116 72 112 L112 108 Q130 92 150 104 L196 132 Q210 150 200 166 L44 170 Q36 164 40 150 Z',
  bag: 'M60 100 L180 100 L190 210 L50 210 Z M90 100 Q90 56 120 56 Q150 56 150 100',
  hat: 'M60 150 Q60 70 120 70 Q180 70 180 150 Z M48 150 L192 150 L192 166 L48 166 Z',
  underwear: 'M64 90 L176 90 L170 120 Q140 130 128 176 L112 176 Q100 130 70 120 Z',
};

function shapeFor(a) {
  const t = (a.product_type_name || '').toLowerCase();
  const g = a.product_group_name || '';
  if (/sneaker|shoe|boot|sandal/.test(t) || g === 'Shoes') return SHAPES.shoe;
  if (/bag/.test(t)) return SHAPES.bag;
  if (/hat|beanie|cap/.test(t)) return SHAPES.hat;
  if (/sock|tights|legging/.test(t)) return t.includes('legging') ? SHAPES.trousers : SHAPES.socks;
  if (/swim|bikini/.test(t)) return SHAPES.swim;
  if (/bra|underwear/.test(t)) return SHAPES.underwear;
  if (/coat|jacket|blazer/.test(t)) return SHAPES.outer;
  if (/vest top/.test(t)) return SHAPES.vest;
  if (/sweater|hoodie|shirt$|blouse|cardigan/.test(t) && !t.includes('t-shirt')) return SHAPES.longsleeve;
  if (/shorts/.test(t)) return SHAPES.shorts;
  if (/trousers|jeans/.test(t)) return SHAPES.trousers;
  if (/skirt/.test(t)) return SHAPES.skirt;
  if (/dress|jumpsuit|playsuit/.test(t) || g === 'Garment Full body') return SHAPES.dress;
  return SHAPES.top;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function render(article) {
  const fill = COLOURS[article.colour_group_name] || COLOURS[article.perceived_colour_master_name] || '#b9a58f';
  const light = ['White', 'Off White', 'Light Beige', 'Light Pink', 'Light Blue', 'Light Grey'].includes(article.colour_group_name);
  const stroke = light ? '#cfc6bb' : 'rgba(0,0,0,0.18)';
  const pattern = article.graphical_appearance_name;
  let deco = '';
  if (pattern === 'Stripe') {
    deco = Array.from({ length: 9 }, (_, i) => `<rect x="0" y="${40 + i * 20}" width="240" height="6" fill="#fff" opacity="0.35"/>`).join('');
  } else if (pattern === 'All over pattern') {
    deco = Array.from({ length: 30 }, (_, i) => `<circle cx="${40 + (i % 6) * 32}" cy="${40 + Math.floor(i / 6) * 38}" r="4" fill="#fff" opacity="0.4"/>`).join('');
  } else if (pattern === 'Melange') {
    deco = Array.from({ length: 50 }, (_, i) => `<rect x="${(i * 37) % 200 + 20}" y="${(i * 53) % 200 + 20}" width="3" height="3" fill="#fff" opacity="0.3"/>`).join('');
  }
  const d = shapeFor(article);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" role="img" aria-label="${escapeXml(article.prod_name)}">
  <rect width="240" height="300" fill="#f7f4f1"/>
  <defs><clipPath id="c"><path d="${d}" transform="translate(0 30)"/></clipPath></defs>
  <path d="${d}" transform="translate(0 30)" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" fill-rule="evenodd"/>
  <g clip-path="url(#c)">${deco}</g>
  <text x="16" y="284" font-family="IBM Plex Mono, monospace" font-size="10" fill="#595959" letter-spacing="0.4">${escapeXml(article.article_id)}</text>
</svg>`;
}

module.exports = { render };
