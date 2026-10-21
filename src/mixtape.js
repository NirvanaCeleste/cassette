/* 这盘磁带的全部内容：A/B 两个带面、13 首歌，以磁带封面（J-card）印刷为准。
   starts 是对母带做静音检测实测的每首起始秒数（磁带首尾与曲间留白都算在内），
   所以点播、报歌名都和真实走带对得上。approx 是该面的实际音频时长（秒），
   音频元数据没就绪时用来画刻度。 */
export const MIXTAPE = {
  title: '苍穹耳语无限无垠',
  no: 'MIXTAPE NO.001',
  year: '2026',
  sides: {
    A: {
      cn: 'SIDE A',
      total: '28:46',
      approx: 1739.9,
      src: 'assets/A%20side.mp3',
      starts: [16.5, 250.5, 414.3, 628.7, 866.5, 1163.4, 1447.8],
      tracks: [
        ['01', 'Floating in Space', '3:54'],
        ['02', 'Far', '2:59'],
        ['03', 'Baby Blue', '3:34'],
        ['04', 'Creep', '3:55'],
        ['05', 'The Great Gig in the Sky', '4:44'],
        ['06', 'My Time (lofi)', '4:49'],
        ['07', 'Obstacles', '4:51'],
      ],
    },
    B: {
      cn: 'SIDE B',
      total: '27:00',
      approx: 1676.8,
      src: 'assets/B%20side.mp3',
      starts: [0, 209.5, 558.5, 891.0, 1165.2, 1385.3],
      tracks: [
        ['08', 'Timber Hearth', '3:24'],
        ['09', 'Weird Fishes', '5:16'],
        ['10', 'Blind Spots', '5:26'],
        ['11', 'Never Meant', '4:26'],
        ['12', 'Field of Hopes and Dreams', '3:35'],
        ['13', 'Skies Forever Blue', '4:53'],
      ],
    },
  },
};

export const otherSide = (s) => (s === 'A' ? 'B' : 'A');

/** 该时刻落在哪一首（磁带上的真实位置，含曲间留白） */
export function trackAt(s, t) {
  const st = MIXTAPE.sides[s].starts;
  let idx = 0;
  for (let i = 0; i < st.length; i++) if (t >= st[i] - 0.4) idx = i;
  return idx;
}
