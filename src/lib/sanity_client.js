const env = require('../config/environment');

const sanity = require('@sanity/client');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const _ = require('underscore');
const { nanoid } = require('nanoid');
const NodeCache = require('node-cache');

const { filterInstrumentName } = require('./utils');
const { bands } = require('./datastore');

const sanityCache = new NodeCache({
  stdTTL: 60 * 60 * 24 * 7,
  useClones: true,
});

const PROJECT = env.config.sanity.project;
const TOKEN = env.config.sanity.token;
const DATASET = env.config.sanity.dataset;
const instruments = env.instruments;

var sanityClient = null;
function getSanityClient() {
  if (!sanityClient) {
    sanityClient = sanity({
      projectId: PROJECT,
      dataset: DATASET,
      token: TOKEN,
      useCdn: false,
      ignoreBrowserTokenWarning: DATASET === 'test',
    });
  }
  return sanityClient;
}

function getAdminUserData(email) {
  // we want admin user data for nearly all API requests. Cache it..
  if (sanityCache.has(email)) {
    return Promise.resolve(sanityCache.get(email));
  }
  return getSanityClient()
    .fetch(
      `*[_type == $type && email == $email && enabled && !(_id in path("drafts.**"))][0]{
    name, email, friendly_name, phone, portrait, _id, _type,
    "portraitUrl": portrait.asset->url
  }`,
      {
        type: 'adminUser',
        email,
      }
    )
    .then(userData => {
      sanityCache.set(email, userData);
      return userData;
    });
}

function getUserData(id) {
  // we want user data for most API requests from non-admins too, cache it..
  if (sanityCache.has(id)) {
    return Promise.resolve(sanityCache.get(id));
  }
  return getSanityClient()
    .fetch(
      `*[_type == $type && _id == $id && !(_id in path("drafts.**"))][0]{
    name, email, phone, instrument, "portrait": portrait.asset->, _id, _type,
    "band": band->{name,
      "palette": logo.asset->metadata.palette,
      "logoUrl": logo.asset->url
    }
  }`,
      {
        type: 'member',
        id,
      }
    )
    .then(userData => {
      sanityCache.set(id, userData);
      return userData;
    });
}

function getBandsForAdminUser(userId) {
  return getSanityClient().fetch(
    `*[_type == $type && references($userId) && !(_id in path("drafts.**"))]{
    ..., "logoUrl": logo.asset->url,
    "palette": logo.asset->metadata.palette,
    "members": *[_type == "member" && references(^._id) && visible] {
      ..., "portraitUrl": portrait.asset->url
    }
  }`,
    { type: 'band', userId }
  );
}

function getProjects(userId, start = 0, end = 20) {
  return getSanityClient().fetch(
    `*[_type == $type && owner._ref == $userId && !(_id in path("drafts.**"))] {
      name, _id, sheetmusic,
      "sheetmusicFile": sheetmusic.asset->url
    }
    | order(_createdAt desc) | [$start .. $end]`,
    {
      type: 'project',
      userId,
      start,
      end,
    }
  );
}

function getMembers(bandId) {
  return getSanityClient().fetch(
    `*[_type == $type && references($bandId) && visible && !(_id in path("drafts.**"))] {
      name, _id, instrument
    } | order(name asc)`,
    {
      type: 'member',
      bandId,
    }
  );
}

function getProjectScoreData(projectId) {
  return getSanityClient().fetch(
    `*[_type == $type && _id == $projectId && !(_id in path("drafts.**"))] {
      _id, "sheetmusicFile": sheetmusic.asset->url, partslist
    }[0]`,
    {
      type: 'project',
      projectId,
    }
  );
}

function getProject(userId, projectId, mustBeFresh) {
  // userId can be either an admin user or a regular band member user ID
  // admin user will get more data from this method, however: no members details
  // for a non-admin
  let id = `project-${userId}-${projectId}`;
  if (sanityCache.has(id) && !mustBeFresh) {
    return Promise.resolve(sanityCache.get(id));
  }
  const client = getSanityClient();
  return Promise.all([
    client.fetch(
      `*[_type == $type && _id == $projectId][0] {
      name, _id, sheetmusic, bpm,
      "sheetmusicFile": sheetmusic.asset->url,
      owner, partslist, generated_soundfile,
      "bandAdmins": band->owner
    }`,
      {
        type: 'project',
        userId,
        projectId,
      }
    ),
    getRecordings(projectId),
  ]).then(results => {
    if (!results[0]) {
      console.error('no result!?');
      return null;
    }
    let project = results[0];
    let recordings = results[1];
    let userIsBandAdmin =
      project.owner._ref === userId ||
      Boolean(project.bandAdmins.find(bA => bA._ref === userId));

    console.log('requested by owner or band admin?', userIsBandAdmin);
    // We allow band admins, project owner and members who have parts to load data
    if (
      !(
        userIsBandAdmin ||
        project.partslist.find(
          part =>
            part.members && part.members.find(member => member._ref === userId)
        )
      )
    ) {
      // the user is not a musician for this project.. odd!
      console.error('user not admin or musician for requested project');
      return null;
    }
    // Acceptable user is requesting data. We should also include the secret links for all members
    if (project.partslist) {
      project.partslist.forEach(part => {
        if (part.members) {
          part.members.forEach(memRef => {
            if (userIsBandAdmin) {
              memRef.token = jwt.sign(
                { userId: memRef._ref, projectId },
                env.config.site.tokensecret
              );
            }
            // TODO: "listening to others while recording enabled"-setting for project?
            let recording = recordings.find(r => r.member._ref === memRef._ref);
            if (recording) {
              memRef.recording = recording;
            }
          });
        }
      });
      // TODO: enable caching projects, listen for updates
      // sanityCache.set(id, project);
      //console.log(JSON.stringify(project, null, 2))
      return project;
    }
  });
}

function addProject(userId, bandId, name, mxmlFile, partslist, bpm, members) {
  const client = getSanityClient();
  return client.assets
    .upload('file', mxmlFile.buffer, { filename: mxmlFile.originalname })
    .then(filedoc => {
      const tempMapping = {};
      partslist = partslist
        .map(part => {
          // The name of the part might be "Trumpet 1" etc
          // but it might also mention the name of a member,
          // in the latter case we can complete the assignment
          const member = members.find(member => {
            return (
              part
                .toLowerCase()
                .indexOf(member.name.toLowerCase().split(' ')[0]) > -1
            );
          });
          if (member) {
            // this score part mentions a name
            if (tempMapping[part]) {
              // We have assigned somebody else already, add to the list
              tempMapping[part].push({ _type: 'reference', _ref: member._id });
              return;
            }
            const assignmentObj = {
              _key: nanoid(),
              _type: 'projectassignment',
              part,
              members: [{ _type: 'reference', _ref: member._id }],
            };
            tempMapping[part] = assignmentObj.members;
            return assignmentObj;
          }
          // This is a generic part name, no musician assigned (which we know about)
          return {
            _key: nanoid(),
            part,
            _type: 'projectassignment',
            members: [],
          };
        })
        .filter(obj => obj); // remove any nulls
      return client
        .create({
          _type: 'project',
          owner: { _type: 'reference', _ref: userId },
          band: { _type: 'reference', _ref: bandId },
          name,
          bpm: parseInt(bpm),
          sheetmusic: {
            _type: 'file',
            asset: { _type: 'reference', _ref: filedoc._id },
          },
          partslist,
        })
        .then(project => getProject(userId, project._id, true));
    });
}

function updateProject(userId, projectId, data) {
  const client = getSanityClient();
  return client.getDocument(projectId).then(oldData => {
    if (oldData.owner._ref !== userId) {
      throw new Error('not allowed');
    }

    Object.assign(oldData, data);
    return client
      .createOrReplace(oldData)
      .then(result => getProject(userId, projectId, true));
  });
}

async function updateOrCreateMember(data, bandId, portraitFile) {
  const client = getSanityClient();

  ['phone', 'email'].forEach(prop => {
    // probably not relevant if we get JSON data, but just in case..
    if (typeof data[prop] === 'string') {
      data[prop] = data[prop].split(/,/g);
    }
  });

  let oldData;
  if (data._id) {
    oldData = await client.getDocument(data._id);
  }

  let portraitDoc;
  if (portraitFile) {
    portraitDoc = await client.upload('image', fs.createReadStream(filepath));
  }

  let update = { _type: 'member', visible: true };
  Object.assign(
    update,
    oldData || {},
    _.pick(
      data,
      '_id',
      'name',
      'phone',
      'email',
      'instrument',
      'subgroup',
      'visible'
    )
  );
  if (bandId) {
    update.band = { _type: 'reference', _ref: bandId };
  }
  if (portraitDoc) {
    update.portrait = {
      _type: 'image',
      asset: { _type: 'reference', _ref: portraitDoc._id },
    };
  }
  const result = await (update._id
    ? client.createOrReplace(update)
    : client.create(update));

  // Clean up: remove the old image file if we have a new one
  if (oldData && oldData.portrait && portraitFile) {
    await client.delete(oldData.portrait.asset._ref);
  }
  return result;
}

function addProjectRecording(projectId, memberId, instrument, filepath) {
  const cl = getSanityClient();
  return cl
    .fetch(
      `*[_type == $type &&
    references($projectId) &&
    references($memberId)]`,
      { type: 'recording', projectId, memberId }
    )
    .then(oldRecordings => {
      return Promise.all(
        oldRecordings.map(recording => {
          return cl
            .delete(recording._id)
            .then(() => cl.delete(recording.file.asset._ref));
        })
      );
    })
    .then(() => {
      return cl.assets
        .upload('file', fs.createReadStream(filepath))
        .then(doc => {
          return cl
            .create({
              _type: 'recording',
              project: {
                _type: 'reference',
                _ref: projectId,
              },
              member: {
                _type: 'reference',
                _ref: memberId,
              },
              file: {
                _type: 'file',
                asset: {
                  _type: 'reference',
                  _ref: doc._id,
                },
              },
              volume: 100,
              instrument,
            })
            .then(() => getProject(memberId, projectId, true));
        });
    });
}

function getRecordings(projectId) {
  return getSanityClient().fetch(
    `*[
        _type == $type && references($projectId)
      ] {_id, _createdAt, member, "url": file.asset->url, volume}`,
    {
      type: 'recording',
      projectId: projectId,
    }
  );
}

// OLD code

function addHelpRecording(projectName, filepath) {
  const cl = getSanityClient();
  return getProject(projectName).then(project => {
    return cl.assets.upload('file', fs.createReadStream(filepath)).then(doc => {
      return cl
        .patch(project._id)
        .set({
          helprecording: {
            _type: 'file',
            asset: {
              _type: 'reference',
              _ref: doc._id,
            },
          },
        })
        .commit();
    });
  });
}

function removeHelpRecording(projectName, fileId) {
  const cl = getSanityClient();
  return getProject(projectName).then(project => {
    return cl
      .transaction()
      .patch(cl.patch(project._id).unset(['helprecording']))
      .delete(fileId)
      .commit();
  });
}

function addImage(projectName, filepath) {
  const cl = getSanityClient();
  return getProject(projectName).then(project => {
    return cl.assets
      .upload('image', fs.createReadStream(filepath))
      .then(doc => {
        return cl
          .patch(project._id)
          .setIfMissing({ images: [] })
          .append('images', [
            {
              _type: 'image',
              asset: {
                _type: 'reference',
                _ref: doc._id,
              },
            },
          ])
          .commit();
      });
  });
}

function addRecording(projectName, pupil, meta, filepath) {
  const cl = getSanityClient();
  return getProject(projectName).then(project => {
    return cl.assets
      .upload('file', fs.createReadStream(filepath), {
        filename: pupil + '-opptak.mp3',
      })
      .then(doc => {
        return cl.create({
          _type: 'recording',
          pupil,
          project: {
            _ref: project._id,
          },
          recording: {
            _type: 'file',
            asset: {
              _type: 'reference',
              _ref: doc._id,
            },
          },
          meta,
        });
      });
  });
}

function purgeCache() {
  sanityCache.flushAll();
}

module.exports = {
  getSanityClient,
  getAdminUserData,
  getUserData,
  getBandsForAdminUser,
  getProjects,
  getMembers,
  getProjectScoreData,
  updateProject,
  updateOrCreateMember,

  getProject,
  addProject,
  addProjectRecording,

  removeHelpRecording,
  addRecording,
  addImage,
  getRecordings,
  purgeCache,
};
