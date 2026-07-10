export default function handler(req: any, res: any) {
  res.status(200).json({
    status: "ok",
    version: "6.1",
    platform: "vercel",
    time: new Date().toISOString()
  });
}