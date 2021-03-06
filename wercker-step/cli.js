#!/usr/bin/env node
const { version } = require('./package.json');
const { createReadStream } = require('fs');
const spacetime = require('spacetime');
const program = require('commander');
const { resolve } = require('path');
const { sep } = require('path');
const AWS = require('aws-sdk');
const log = require('npmlog');
const glob = require('glob');

const argDescriptions = {
  pattern: 'glob patterns of files to upload (default: *)'
}

const objectExistsError = Error('should not exist');
const unknownExistsError = Error('unknown if file exists');

program
  .description('Upload assets to s3', argDescriptions)
  .usage('[options] -b|--bucket <name> [pattern...]')
  .arguments('[pattern...]')
  .option('-b, --bucket <name>', 'define the destination bucket')
  .option('-s, --source <path>', 'set the base directory', resolve, './')
  .option('-r, --role <arn>', 'use an aws role')
  .option('-R, --no-recurse', 'do not upload recursively') 
  .option('-l, --log-level <level>', 'set a log level', 'info')
  .option('-d, --dry-run', 'do a dry run')
  .option('-f, --force', 'overwrite existing or unknown files')
  .version(version, '-v, --version')
  .parse(process.argv);

if (!program.bucket) {
  program.help();
}

if (!program.args.length) program.args = ['*'];

const pattern = program.args.length === 1
  ? program.args[0]
  : `{${program.args.join(',')}}`

log.level = program.logLevel;

function getMatches() {
  const options = {
    cwd: resolve(program.source),
    nodir: true,
    matchBase: program.recurse,
    absolute: true
  };

  return new Promise((resolve, reject) => {
    log.info('get-matches', 'start glob')
    glob(pattern, options, (err, matches) => {
      log.info('get-matches', 'end glob');
      if (err) return reject(err);
      resolve(matches);
    });
  });
}

async function uploadToS3(files) {
  const log = log.newItem('uploads', files.length);
  let i = 0;
  for (const file of files) {
    log.info('uploadToS3', 'uploading %s', file);
    await new Promise(resolve => setTimeout(resolve, 1));
    log.completeWork(1);
  }
}

function getAWSConfigForRole(RoleArn) {
  const options = {};
  if (RoleArn) {
    options.credentials = new AWS.TemporaryCredentials({RoleArn});
  }
  return new AWS.Config(options);
}

function dirnameWithSlash() {
  let dirname = resolve(program.source);
  if (!dirname.endsWith(sep)) {
    dirname += sep;
  }
  return dirname;
}

const config = getAWSConfigForRole(program.role);
const s3 = new AWS.S3(config);

const before = spacetime.now();
log.notice('main', 'starting');

// async party!!!
(async () => {
  const prefix = dirnameWithSlash();
  const options = { Bucket: program.bucket };
  let listBucketPermission = true;

  log.enableProgress();
  const matches = await getMatches();

  if (program.dryRun) {
    matches.forEach(match => log.notice('dry-run', match));
    return;
  }

  await s3.headBucket(options).promise().catch(e => {
    if (e.code === 'Forbidden') {
      listBucketPermission = false;
      return log.notice('prerequisite', 'no permissions to listBucket - skipping');
    }
    throw e;
  });

  for (const match of matches) {
    if (!match.startsWith(prefix)) {
      log.error('upload-to-s3', 'invalid file - skipping %s', match);
      continue;
    }
    
    options.Key = match.substring(prefix.length); 
    try {
      await s3.headObject(options).promise().then(
        () => { if (!program.force) throw objectExistsError; },
        err => {
          if (listBucketPermission && err.code === 'NotFound') {
            return null;
          }
          if (!listBucketPermission && err.code === 'Forbidden') {
            if (program.force) return null;
            throw unknownExistsError;
          }
          throw err;
        }
      );
      options.Body = createReadStream(match);
      log.info('upload-to-s3', 'uploading %s', match);
      await s3.upload(options).promise();
    } catch (e) {
      if (e === unknownExistsError) {
        throw Error('file may exist - add listBucket permission or use --force');
      }
      if (e === objectExistsError) {
        log.notice('upload-to-s3', 'file exists - skipping %s', options.Key);
        continue;
      } else {
        log.error('upload-to-s3', 'failed to upload %s', options.Key);
        log.verbose('upload-to-s3', e.stack);
      }
    }
  }
})().then(() => {
  log.disableProgress();
  log.notice('main', 'completed %s', spacetime.now().since(before).qualified);
}).catch(err => {
  log.disableProgress();
  log.error('main', 'failed %s', before.since(spacetime.now()).qualified);
  log.error('main', err.stack);
});
