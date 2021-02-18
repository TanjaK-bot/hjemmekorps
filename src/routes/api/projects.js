import multer from 'multer';

const storage = multer.memoryStorage();
const multerUpload = multer({ storage: storage });

import sClient from '../../lib/sanity_client';
import { generateSVGImage } from '../../lib/mxml_to_svg';
import {
  parseFile,
  getName,
  getMemberNames,
  getPartsList,
} from '../../lib/mxml_helpers';

export async function get(req, res, next) {
  return sClient.getProjects(req.user._id).then(projects => {
    res.json(projects);
  });
}

export async function post(req, res, next) {
  multerUpload.single('file')(req, res, () => {
    if (!req.file) {
      res.statusCode = 400;
      return res.json({ error: 'Missing files' });
    }
    const bandId = req.body.band;
    const mxlmData = parseFile(req.file);
    return sClient.getMembers(bandId).then(bandMembers => {
      const partslist = getPartsList(mxlmData);
      const projName = getName(mxlmData);
      return sClient
        .addProject(
          req.user._id,
          bandId,
          projName,
          req.file,
          partslist,
          req.body.bpm,
          bandMembers
        )
        .then(project => {
          res.json(project);
          // process parts, convert to SVG
          return Promise.all(
            project.partslist.map(async partinfo => {
              const svgMarkup = await generateSVGImage(
                req.file.buffer.toString('utf-8'),
                partinfo.part,
                800,
                0,
                true
              );
              return await sClient.addPartFile(
                project._id,
                partinfo.part,
                Buffer.from(svgMarkup[0], 'utf8')
              );
            })
          );
        });
    });
  });
}
