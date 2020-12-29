import multer from "multer";

const storage = multer.memoryStorage();
const multerUpload = multer({ storage: storage });

import sClient from "../../lib/sanity_client";
import { parse, getName, getMemberNames } from "../../lib/mxml_helpers";


export async function get(req, res, next) {
	return sClient.getProjects(req.user._id).then((projects) => {
		res.json(projects);
	});
}

export async function post(req, res, next) {
	multerUpload.single("file")(req, res, (req, res) => {
		if (!req.file) {
			return res.status(400).json({ error: "Missing files" });
		}
		const bandName = req.body.band;
		const mxlmData = parse(req.file);
		const bandMembers = getMemberNames(mxlmData);
		const projName = getName(mxlmData);
		return sClient.ensureMembersExist(req.user._id, bandName, bandMembers).then(memberData => {
			return sClient
				.addProject(req.user._id, projName, req.file, memberData)
				.then((project) => {
					res.json(project);
				});
		});
	});
}
