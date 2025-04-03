import { Context, Schema, h } from 'koishi'

export const name = 'vv-bot'

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

async function fetchData(url: string | URL | Request) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  const data = await response.text();
  //const match = data.match(/{[\s\S]*?}/);
  //if (match) {
  //  console.log(response);
  //  return match[0];
  //}
  //console.log(response);
  return data;
}

interface Result {
  filename?: string;
  timestamp?: string;
  similarity?: number;
  text?: string;
  match_ratio?: number;
  exact_match?: boolean;
}

/**
 * 将 API 返回的多行 JSON 文本解析为对象数组
 * 每行内容类似：
 * {"filename":"[P070]70 百年未有之大变局（下）.json","timestamp":"34m17s", ...}
 */
function parseApiResults(apiText: string): Result[] {
  const lines = apiText.split('\n').filter(line => line.trim() !== '');
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      console.error("解析 JSON 行失败:", line, e);
      return null;
    }
  }).filter((item): item is Result => item !== null);
}

/**
 * 根据 groupIndex 从服务器获取索引文件数据（ArrayBuffer 格式）
 * @param groupIndex 根据 folderId 计算得到的组索引
 * @param baseUrl 服务器基础 URL，例如 "https://vv.noxylva.org"
 */
async function fetchIndex(groupIndex: number, baseUrl: string): Promise<ArrayBuffer> {
  const indexUrl = `${baseUrl}/${groupIndex}.index`;
  const response = await fetch(indexUrl);
  if (!response.ok) {
    throw new Error(`获取索引失败: ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

/**
 * 解析索引数据，利用二分查找定位指定文件夹和帧号对应的起始偏移量和结束偏移量
 * @param indexData 索引文件数据（ArrayBuffer）
 * @param folderId 从文件名中提取的文件夹编号（例如 "[P070]" 提取 70）
 * @param frameNum 由时间戳转换的秒数（例如 "34m17s" 转为 2057）
 */
function parseIndex(
  indexData: ArrayBuffer,
  folderId: number,
  frameNum: number
): { startOffset: number; endOffset?: number } | null {
  const dataView = new DataView(indexData);
  let offset = 0;
  // 读取 gridW、gridH、folderCount（各 4 字节）
  const gridW = dataView.getUint32(offset, true);
  offset += 4;
  const gridH = dataView.getUint32(offset, true);
  offset += 4;
  const folderCount = dataView.getUint32(offset, true);
  offset += 4;
  // 跳过 folderCount * 4 字节
  offset += folderCount * 4;
  // 读取文件记录数（4 字节）
  const fileCount = dataView.getUint32(offset, true);
  offset += 4;

  let left = 0, right = fileCount - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    // 每条记录 16 字节：folder（4）+ frame（4）+ currOffset（8）
    const recordOffset = offset + mid * 16;
    const currFolder = dataView.getUint32(recordOffset, true);
    const currFrame = dataView.getUint32(recordOffset + 4, true);
    const currOffset = Number(dataView.getBigUint64(recordOffset + 8, true));

    if (currFolder === folderId && currFrame === frameNum) {
      let endOffset: number | undefined = undefined;
      if (mid < fileCount - 1) {
        const nextRecordOffset = offset + (mid + 1) * 16;
        endOffset = Number(dataView.getBigUint64(nextRecordOffset + 8, true));
      }
      return { startOffset: currOffset, endOffset };
    } else if (
      currFolder < folderId || (currFolder === folderId && currFrame < frameNum)
    ) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return null;
}

/**
 * 将 Blob 转换为 Data URL（适用于 Node 环境）
 * @param blob Blob 对象
 * @returns Promise<string> 转换后的 Data URL 字符串
 */
async function blobToDataURL(blob: Blob): Promise<string> {
  // 使用 Blob.arrayBuffer 获取 ArrayBuffer，再用 Buffer 转换为 Base64 字符串
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:image/webp;base64,${base64}`;
}

/**
 * 根据 folderId 和 frameNum 获取缩略图的 Blob 数据
 * @param folderId 文件夹编号（例如从 "[P070]" 中提取的 70）
 * @param frameNum 帧号（总秒数，例如 "34m17s" 转换后的 2057）
 * @param baseUrl 服务器基础 URL，例如 "https://vv.noxylva.org"
 */
async function extractFrame(
  folderId: number,
  frameNum: number,
  baseUrl: string
): Promise<Blob | null> {
  const groupIndex = Math.floor((folderId - 1) / 10);
  try {
    const indexData = await fetchIndex(groupIndex, baseUrl);
    const offsetInfo = parseIndex(indexData, folderId, frameNum);
    if (!offsetInfo) {
      console.error(`未找到 folder ${folderId} 中 frame ${frameNum}`);
      return null;
    }
    const { startOffset, endOffset } = offsetInfo;
    const imageUrl = `${baseUrl}/${groupIndex}.webp`;
    const headers: HeadersInit = {};
    if (endOffset) {
      headers["Range"] = `bytes=${startOffset}-${endOffset - 1}`;
    } else {
      headers["Range"] = `bytes=${startOffset}-`;
    }
    let response = await fetch(imageUrl, { method: "GET", headers });
    if (response.status === 416 || !response.ok) {
      response = await fetch(imageUrl, { method: "GET" });
    }
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error("空响应");
    }
    return new Blob([blob], { type: "image/webp" });
  } catch (error: any) {
    console.error(`提取 folder ${folderId} 中 frame ${frameNum} 时出错:`, error);
    return null;
  }
}

/**
 * 根据 folderId 和 frameNum 获取缩略图的 Data URL
 * @param folderId 文件夹编号（例如 "[P070]" 中提取的 70）
 * @param frameNum 帧号（总秒数，例如 "34m17s" 转换后的 2057）
 * @param baseUrl 服务器基础 URL，例如 "https://vv.noxylva.org"
 * @returns Promise<string | null> 成功返回 Data URL，否则返回 null
 */
async function getThumbnailDataURL(
  folderId: number,
  frameNum: number,
  baseUrl: string
): Promise<string | null> {
  const frameBlob = await extractFrame(folderId, frameNum, baseUrl);
  if (frameBlob) {
    return await blobToDataURL(frameBlob);
  }
  return null;
}

/**
 * 针对 API 返回的文本适配函数
 * 解析每行 JSON 后提取 filename 和 timestamp，并利用 getThumbnailDataURL 获取对应的 Data URL 列表
 * @param apiText API 返回的多行 JSON 文本
 * @param baseUrl 服务器基础 URL，例如 "https://vv.noxylva.org"
 */
async function getPreviewImageDataUrlsFromText(apiText: string, baseUrl: string): Promise<string[]> {
  const results = parseApiResults(apiText);
  const urls: string[] = [];
  for (const result of results) {
    const filename = result.filename;
    const timestamp = result.timestamp;
    if (!filename || !timestamp) continue;
    const folderMatch = filename.match(/\[P(\d+)\]/);
    const timeMatch = timestamp.match(/^(\d+)m(\d+)s$/);
    if (!folderMatch || !timeMatch) continue;
    const folderId = parseInt(folderMatch[1], 10);
    const minutes = parseInt(timeMatch[1], 10);
    const seconds = parseInt(timeMatch[2], 10);
    const totalSeconds = minutes * 60 + seconds;
    const dataUrl = await getThumbnailDataURL(folderId, totalSeconds, baseUrl);
    if (dataUrl) {
      urls.push(dataUrl);
    }
  }
  return urls;
}

export function apply(ctx: Context) {
  ctx.command('vv <message> [count:number]', '搜索 VV 表情包')
    .action(async (_, parameter, count) => {
      if (!parameter) return "请输入搜索关键词";
      if (!count) count = 1;
      if (count > 5) count = 5;
      try {
        const url = `https://vvapi.cicada000.work/search?query=${parameter}&min_ratio=50&min_similarity=0.5&max_results=${count}`;

        const apiText = await fetchData(url);
        const baseUrl = "https://vv.noxylva.org";
        const urls = await getPreviewImageDataUrlsFromText(apiText, baseUrl);
        //console.log("生成的预览 Data URL:", urls);
        let res = [];
        for (const dataUrl of urls) {
          res.push(h.image(dataUrl));
        }
        return res;
      } catch (error) {
        console.error("搜索 VV 表情包时出错:", error);
        return "搜索 VV 表情包时出错, 请再试一次";
      }
    });
}
