function jsonSender(req, res, next) {
  res.json = data => {
    res.setHeader('Content-type', 'application/json');
    if (typeof data === 'string') {
      res.write(data);
    } else {
      res.write(JSON.stringify(data));
    }
    res.end();
  };
  next();
}

function parseUrl(req, res, next) {
  req.location = new URL(
    req.url,
    `${req.protocol || 'http'}://${req.headers.host}`
  );
  //console.log('location', req.location)
  next();
}

function setCookie(req, res, next) {
  res.setCookie = function (name, value, options) {
    const cookieOpts = [];
    if(options && options.expires) {
      cookieOpts.push('Expires=' + options.expires.toGMTString());
    }
    if (options && options.path) {
      cookieOpts.push('Path=' + options.path);
    }
    let optsString = '';
    if (cookieOpts.length) {
      optsString = '; ' + cookieOpts.join('; ');
    }
    res.setHeader(
      'Set-Cookie',
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}${optsString}`
    );
  };

  next();
}

function filterInstrumentName(someName, instrumentList) {
  let instrumentFromList = instrumentList.find(instrument => {
    return someName.toLowerCase().indexOf(instrument.value) > -1;
  });
  if (instrumentFromList) {
    return instrumentFromList.value;
  }
}

function getRandomInt(min, max) {
  return parseInt(Math.random() * (max - min) + min);
}

module.exports = {
  jsonSender,
  parseUrl,
  setCookie,
  filterInstrumentName,
  getRandomInt,
};
