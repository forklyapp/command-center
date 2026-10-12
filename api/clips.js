// GET /api/clips -> your YouTube Shorts with views, engagement and estimated campaign earnings.
// Vercel env vars: YOUTUBE_API_KEY, YOUTUBE_HANDLE (like @BloxDrops), APP_PASSCODE.
// Optional: CLIP_CPM (default 1.00), CLIP_MIN (default 2), CLIP_MAX (default 300).

function send(res, code, obj){ res.setHeader("Cache-Control", "no-store"); res.status(code).json(obj); }
function authorized(req){
  const pass = process.env.APP_PASSCODE || "", got = String(req.headers["x-passcode"] || "");
  return !!pass && got.length === pass.length && [...pass].every((c, i) => c === got[i]);
}
async function yt(path){
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("YouTube: " + ((d.error && d.error.message) || r.status));
  return d;
}

export default async function handler(req, res){
  if (!process.env.YOUTUBE_API_KEY || !process.env.YOUTUBE_HANDLE) return send(res, 200, { connected: false, reason: "Add YOUTUBE_API_KEY and YOUTUBE_HANDLE in Vercel to connect YouTube." });
  if (!authorized(req)) return send(res, 401, { error: "Wrong or missing passcode." });
  try {
    const handle = process.env.YOUTUBE_HANDLE.trim().replace(/^@?/, "@");
    const ch = await yt(`channels?part=snippet,statistics,contentDetails&forHandle=${encodeURIComponent(handle)}`);
    const c = (ch.items || [])[0];
    if (!c) throw new Error(`No YouTube channel found for ${handle}. Check YOUTUBE_HANDLE.`);
    const uploads = c.contentDetails.relatedPlaylists.uploads;
    const pl = await yt(`playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`);
    const ids = (pl.items || []).map(i => i.contentDetails.videoId);
    let videos = [];
    if (ids.length) {
      const v = await yt(`videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
      const cpm = Number(process.env.CLIP_CPM || 1), min = Number(process.env.CLIP_MIN || 2), max = Number(process.env.CLIP_MAX || 300);
      videos = (v.items || []).map(x => {
        const views = Number(x.statistics.viewCount || 0), likes = Number(x.statistics.likeCount || 0), comments = Number(x.statistics.commentCount || 0);
        const raw = views / 1000 * cpm, est = raw < min ? 0 : Math.min(max, raw);
        return { id: x.id, title: x.snippet.title, url: `https://www.youtube.com/shorts/${x.id}`, at: Date.parse(x.snippet.publishedAt),
          views, likes, comments, engagement: views ? (likes + comments) / views : 0, est: Math.round(est * 100) / 100, toMin: raw < min ? Math.ceil(min / cpm * 1000) - views : 0 };
      }).sort((a, b) => b.at - a.at);
    }
    send(res, 200, {
      connected: true, channel: { title: c.snippet.title, handle, subscribers: Number(c.statistics.subscriberCount || 0), views: Number(c.statistics.viewCount || 0) },
      videos, totals: { views: videos.reduce((a, v) => a + v.views, 0), est: Math.round(videos.reduce((a, v) => a + v.est, 0) * 100) / 100, count: videos.length }
    });
  } catch (e) { send(res, 500, { error: e.message || String(e) }); }
}
