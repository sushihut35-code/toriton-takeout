// 鳥とん メニューデータ(予備)
// ★ 普段はボードの「📝メニュー管理」から変更する(Supabaseのmenu_items)。
// ★ このファイルはSupabaseが読めない時の予備として使われる。
const MENU = {
  categories: [
    {
      id: 'yaki',
      name: '炭火焼き',
      emoji: '🔥',
      items: [
        {
          id: 'pork-momo', name: '豚もも炭火焼き', price: 1500,
          options: [{ name: '柚子胡椒', price: 50 }],
        },
        {
          id: 'chicken-momo', name: '鶏モモ炭火焼き', price: 1400,
          options: [{ name: '柚子胡椒', price: 50 }],
        },
        { id: 'tataki',       name: '鶏のたたき',     price: 1500 },
      ],
    },
    {
      id: 'tebasaki',
      name: '手羽先唐揚げ',
      emoji: '🍗',
      items: [
        {
          // 容量違いは「バリエーション」として1つのカードにまとめる
          id: 'tebasaki',
          name: '手羽先唐揚げ',
          variants: [
            { id: 'tebasaki-500',  label: '500g',  price: 850 },
            { id: 'tebasaki-1k',   label: '1kg',   price: 1700 },
            { id: 'tebasaki-15k',  label: '1.5kg', price: 2550 },
          ],
        },
      ],
    },
    {
      id: 'side',
      name: 'サイドメニュー',
      emoji: '🍟',
      items: [
        { id: 'potato', name: 'フライドポテト', price: 300 },
        { id: 'cheese', name: 'カリカリチーズ', price: 400 },
        { id: 'fish',   name: '魚のフライ',     price: 500 },
      ],
    },
  ],
};
