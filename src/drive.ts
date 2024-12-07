import { IRequestStrict } from 'itty-router';

type Oauth2Response = {
	access_token: string;
	expires_in: number;
	refresh_token: string;
	scope: string;
	token_type: string;
};

type FileMeta = {
	id: string;
	mimeType: string;
	name: string;
	kind: string;
};

/*
	Use rclone to get the data
	Step:
	1) Create google api project, enable google drive api.
	2) Go to oauth consent screen, configure that.
	3) Create new credentials, json, desktop app.
	4) Use tutorial on https://rclone.org/drive/
*/
const CLIENT_ID = '';
const CLIENT_SECRET = '';
const REFRESH_TOKEN = '';
const PARENT = 'root';

class GoogleDrive {
	private _accessToken?: string;
	private _dateExpires?: Date;
	private _fileIdCache = new Map<string, FileMeta>();
	constructor() {}

	private enQuery(data: any) {
		const ret = [];
		for (let d in data) {
			ret.push(encodeURIComponent(d) + '=' + encodeURIComponent(data[d]));
		}
		return ret.join('&');
	}

	private getCachedFileId(name: string, parentId: string) {
		return this._fileIdCache.get(name + parentId);
	}

	private putFileIdToCache(name: string, parentId: string, meta: FileMeta) {
		return this._fileIdCache.set(name + parentId, meta);
	}

	private clearFileIdCache() {
		this._fileIdCache.clear();
	}

	private async fetchAccessToken(): Promise<Oauth2Response | undefined> {
		const url = 'https://www.googleapis.com/oauth2/v4/token';
		const postData = {
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: REFRESH_TOKEN,
			grant_type: 'refresh_token',
		};

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: this.enQuery(postData),
			});
			return await response.json();
		} catch (error) {
			return undefined;
		}
	}

	private async getAccessToken() {
		if (this._accessToken && this._dateExpires && Date.now() < this._dateExpires.getTime()) {
			return this._accessToken;
		}

		this._accessToken = undefined;
		this._dateExpires = undefined;
		const session = await this.fetchAccessToken();
		if (!session) {
			throw new Error('fail to get current sesison');
		}

		this._accessToken = session.access_token;
		this._dateExpires = new Date(Date.now() + 3500 * 1000);

		return this._accessToken;
	}

	/***
	 * Wrapped Request With Authorization Header
	 */
	private async request(
		url: string,
		method = 'GET',
		body?: {
			contentType: string;
			body: Request['body'] | string;
		}
	) {
		const accessToken = await this.getAccessToken();
		const headers: any = {
			Authorization: `Bearer ${accessToken}`,
		};
		if (body) {
			headers['Content-Type'] = body.contentType;
		}
		return fetch(url, {
			method,
			headers: headers,
			body: body?.body,
		});
	}

	private async getChildren(parentId: string) {
		const url = new URL(`https://www.googleapis.com/drive/v3/files`);
		url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
		url.searchParams.set('includeItemsFromAllDrives', 'true');
		url.searchParams.set('supportsAllDrives', 'true');

		const res = await this.request(url.toString());

		if (!res.ok) {
			return [];
		}
		const body = (await res.json()) as { files: FileMeta[] };

		return body.files;
	}

	private async getFileMetaByName({ name, parentId = PARENT }: { name: string; parentId: string; trashed?: boolean }) {
		const isCached = this.getCachedFileId(name, parentId);
		if (isCached) {
			return isCached;
		}

		const url = new URL(`https://www.googleapis.com/drive/v3/files`);
		url.searchParams.set('q', `'${parentId}' in parents and name = '${name}' and trashed = false`);
		url.searchParams.set('includeItemsFromAllDrives', 'true');
		url.searchParams.set('supportsAllDrives', 'true');

		const res = await this.request(url.toString());

		if (!res.ok) {
			return undefined;
		}

		const body = (await res.json()) as { files: FileMeta[] };
		const json = body.files![0] as FileMeta;
		if (json) {
			this.putFileIdToCache(name, parentId, json);
		}

		return json;
	}

	private async createFolder({ parentId, name }: { parentId: string; name: string }) {
		const res = await this.request(`https://www.googleapis.com/drive/v3/files`, 'POST', {
			body: JSON.stringify({
				name: name,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [parentId],
			}),
			contentType: 'application/json',
		});

		if (!res.ok) {
			return undefined;
		}

		const json = (await res.json()) as FileMeta;
		return json;
	}

	private async getFileIDByPath({ path, createFolderIfNotExist = false }: { path: string; createFolderIfNotExist?: boolean }) {
		let paths = path.split('/').filter(Boolean);

		let parentId = PARENT;
		let currentFile: FileMeta | undefined;

		// Return My Drive
		if (paths.length === 0) {
			return {
				id: PARENT,
				name: 'My Drive',
				kind: 'drive#file',
				mimeType: 'application/vnd.google-apps.folder',
			} as FileMeta;
		}

		for (let i = 0; i < paths.length; i++) {
			const name = decodeURIComponent(paths[i]);

			let current = await this.getFileMetaByName({
				name,
				parentId,
			});

			if (!current && createFolderIfNotExist) {
				current = await this.createFolder({
					parentId,
					name,
				});
			}

			if (!current) {
				return undefined;
			}

			parentId = current.id as string;
			currentFile = current;
		}

		return currentFile || undefined;
	}

	public async uploadFile(fileName: string, contentType: string, parentId: string, body: Request['body'], existingFileId?: string) {
		let jsonMetadata: any = {
			name: fileName,
			parents: [parentId],
		};

		if (existingFileId) {
			jsonMetadata = {};
		}

		const resumable = await this.request(
			`https://www.googleapis.com/upload/drive/v3/files${existingFileId ? '/' + existingFileId : ''}?uploadType=resumable`,
			existingFileId ? 'PATCH' : 'POST',
			{
				contentType: 'application/json',
				body: JSON.stringify(jsonMetadata),
			}
		);

		if (!resumable.headers.get('Location')) return new Response(resumable.body, resumable);
		const uploadUrl = resumable.headers.get('Location')!;
		const resp = await this.request(uploadUrl, 'PATCH', {
			contentType,
			body,
		});

		return new Response(resp.body, resp);
	}

	private async removeFileById(id: string) {
		const resp = await this.request(`https://www.googleapis.com/drive/v3/files/${id}`, 'DELETE');
		return new Response(resp.body, resp);
	}

	public async getFileById(fileId: string) {
		const response = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
		const headers: any = {};
		for (const [k, v] of response.headers) {
			headers[k] = v;
		}
		(headers['content-disposition'] = 'inline'), (headers['cache-control'] = 'public');

		return new Response(response.body, {
			headers: headers,
		});
	}

	public async getFileByPath(req: IRequestStrict) {
		const path = new URL(req.url).pathname;
		const file = await this.getFileIDByPath({ path: path, createFolderIfNotExist: false });
		if (!file || file.mimeType === 'application/vnd.google-apps.folder') {
			// folder listing
			if (file /*&& req.headers.get('key') === FOLDER_KEY*/) {
				const child = await this.getChildren(file.id);

				if (req.headers.get('full') === 'true') {
					const thumbs: any[] = [];
					for (const children of child) {
						const res = await this.getChildren(children.id);
						let thumb = '';
						for (const file of res) {
							if (!file.mimeType.includes('image')) continue;
							thumb = `${req.url}/${children.name}/${file.name}`;
							break;
						}
						thumbs.push({
							url: new URL(`${req.url.endsWith('/') ? req.url.slice(0, req.url.lastIndexOf('/')) : req.url}/${children.name}`).toString(),
							thumb,
						});
					}
					return new Response(JSON.stringify(thumbs, null, '\t'), {
						headers: {
							'Content-Type': 'application/json',
						},
					});
				}

				return new Response(
					JSON.stringify(
						child.map((v) =>
							new URL(`${req.url.endsWith('/') ? req.url.slice(0, req.url.lastIndexOf('/')) : req.url}/${v.name}`).toString()
						),
						null,
						'\t'
					),
					{
						headers: {
							'Content-Type': 'application/json',
						},
					}
				);
			}

			return new Response('Not Found', { status: 404 });
		}
		return this.getFileById(file.id);
	}

	public async removeFileByPath(req: IRequestStrict) {
		if (!req.body) return new Response('Bad Request', { status: 400 });
		let paths = new URL(req.url).pathname.split('/').filter(Boolean);
		const fileName = paths.pop();
		const folders = `/${paths.join('/')}`;

		// check filename
		if (!fileName?.length) return new Response('Not Found', { status: 404 });

		// check folder
		const parentFolder = await this.getFileIDByPath({ path: folders, createFolderIfNotExist: true });
		if (!parentFolder || parentFolder?.mimeType !== 'application/vnd.google-apps.folder') {
			return new Response('Not Found', { status: 404 });
		}

		// check existing file
		const file = await this.getFileIDByPath({ path: `${folders}/${fileName}` });
		if (file) return this.removeFileById(file.id);
		else return new Response('Not Found', { status: 404 });
	}

	public async uploadFileByPath(req: IRequestStrict) {
		if (!req.body) return new Response('Bad Request', { status: 400 });
		let paths = new URL(req.url).pathname.split('/').filter(Boolean);
		const fileName = paths.pop();
		const folders = `/${paths.join('/')}`;

		// check filename
		if (!fileName?.length) return new Response('Not Found', { status: 404 });

		// always clear cache when user uploading
		this.clearFileIdCache();

		// check folder
		const parentFolder = await this.getFileIDByPath({ path: folders, createFolderIfNotExist: true });
		if (!parentFolder || parentFolder?.mimeType !== 'application/vnd.google-apps.folder') {
			return new Response('Not Found', { status: 404 });
		}

		const file = await this.getFileIDByPath({ path: `${folders}/${fileName}` });

		return this.uploadFile(fileName, req.headers.get('Content-Type') || 'application/octet-stream', parentFolder.id, req.body, file?.id);
	}
}

export const INSTANCE = new GoogleDrive();
