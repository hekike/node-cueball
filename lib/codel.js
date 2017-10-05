/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2017, Joyent, Inc.
 */

module.exports = {
	ModifiedCoDel: ModifiedCoDel,
	OriginalCoDel: OriginalCoDel,
	DisabledCoDel: DisabledCoDel
};

const mod_assert = require('assert-plus');
const mod_utils = require('./utils');

const CODEL_INTERVAL = 100;
const CODEL_TARGET_DELAY = 500;
const CODEL_LAST_EMPTY_BOUND = 10000;

/*
 * This class allows disabling the controlled delay algorithm,
 * by always indicating that the system is not overloaded.
 */
function DisabledCoDel() {
}

DisabledCoDel.prototype.overloaded = function (start) {
	mod_assert.number(start, 'start');
	return (false);
};

DisabledCoDel.prototype.empty = function () { };

/*
 * This class implements the controlled delay algorithm with
 * the modifications that Facebook made for their systems.
 *
 * See https://queue.acm.org/detail.cfm?id=2839461
 * See https://github.com/facebook/folly/blob/36b8f9c6/folly/executors/Codel.cpp
 */
function ModifiedCoDel(opts) {
	mod_assert.object(opts, 'opts');
	mod_assert.optionalFinite(opts.interval, 'opts.interval');
	mod_assert.optionalFinite(opts.targetDelay, 'opts.targetDelay');

	this.mcd_interval = typeof (opts.interval) === 'number'
	    ? opts.interval
	    : CODEL_INTERVAL;
	this.mcd_targdelay = typeof (opts.targetDelay) === 'number'
	    ? opts.targetDelay
	    : CODEL_TARGET_DELAY;

	this.mcd_overloaded = false;
	this.mcd_resetdelay = true;
	this.mcd_intrvltime = mod_utils.currentMillis();
	this.mcd_mindelay = 0;
}

ModifiedCoDel.prototype._sloughTimeout = function () {
	return (this.mcd_targdelay * 2);
};

ModifiedCoDel.prototype.overloaded = function (start) {
	mod_assert.number(start, 'start');
	var now = mod_utils.currentMillis();
	var delay = now - start;

	if (now > this.mcd_intrvltime && !this.mcd_resetdelay) {
		this.mcd_resetdelay = true;
		this.mcd_intrvltime = now + this.mcd_interval;
		this.mcd_overloaded = (this.mcd_mindelay > this.mcd_targdelay);
	}

	if (this.mcd_resetdelay) {
		this.mcd_resetdelay = false;
		this.mcd_mindelay = delay;
		return (false);
	} else if (delay < this.mcd_mindelay) {
		this.mcd_mindelay = delay;
	}

	return (this.mcd_overloaded && delay > this._sloughTimeout());
};

ModifiedCoDel.prototype.empty = function () {
	this.mcd_last_empty = mod_utils.currentMillis();
};

ModifiedCoDel.prototype.getMaxIdle = function () {
	if (this.isOverloaded()) {
		return (this.mcd_targdelay * 3);
	} else {
		return (CODEL_LAST_EMPTY_BOUND);
	}
};

ModifiedCoDel.prototype.isOverloaded = function () {
	var now = mod_utils.currentMillis();

	return (this.mcd_last_empty < (now - CODEL_LAST_EMPTY_BOUND));
};

/*
 * This class implements the Controlled Delay algorithm as originally
 * described, using the inverse square root control law.
 *
 * See https://queue.acm.org/appendices/codel.html
 */
function OriginalCoDel(opts) {
	mod_assert.object(opts, 'opts');
	mod_assert.optionalFinite(opts.interval, 'opts.interval');
	mod_assert.optionalFinite(opts.targetDelay, 'opts.targetDelay');

	this.ocd_interval = typeof (opts.interval) === 'number'
	    ? opts.interval
	    : CODEL_INTERVAL;
	this.ocd_targdelay = typeof (opts.targetDelay) === 'number'
	    ? opts.targetDelay
	    : CODEL_TARGET_DELAY;

	this.ocd_first_above_time = 0;
	this.ocd_drop_next = 0;
	this.ocd_count = 0;
	this.ocd_dropping = false;
}

OriginalCoDel.prototype.canDrop = function (now, start) {
	var sojournTime = now - start;

	if (sojournTime < this.ocd_targdelay) {
		this.ocd_first_above_time = 0;
	} else if (this.ocd_first_above_time === 0) {
		this.ocd_first_above_time = now + this.ocd_interval;
	} else if (now >= this.ocd_first_above_time) {
		return (true);
	}

	return (false);
};

OriginalCoDel.prototype.getDropNext = function (now) {
	return (now + this.ocd_interval / Math.sqrt(this.ocd_count));
};

OriginalCoDel.prototype.overloaded = function (start) {
	mod_assert.number(start, 'start');
	var now = mod_utils.currentMillis();
	var okToDrop = this.canDrop(now, start);
	var dropClaim = false;

	if (this.ocd_dropping) {
		if (!okToDrop) {
			this.ocd_dropping = false;
		} else if (now >= this.ocd_drop_next) {
			dropClaim = true;
			this.ocd_count += 1;
		}
	} else if (okToDrop &&
	    ((now - this.ocd_drop_next < this.ocd_interval) ||
	     (now - this.ocd_first_above_time >= this.ocd_interval))) {
		dropClaim = true;
		this.ocd_dropping = true;

		if (now - this.ocd_drop_next < this.ocd_interval) {
			this.ocd_count = this.ocd_count > 2
			    ? this.ocd_count - 2 : 1;
		} else {
			this.ocd_count = 1;
		}

		this.ocd_drop_next = this.getDropNext(now);
	}

	return (dropClaim);
};

OriginalCoDel.prototype.empty = function () {
	this.ocd_last_empty = mod_utils.currentMillis();
	this.ocd_first_above_time = 0;
};

OriginalCoDel.prototype.getMaxIdle = function () {
	if (this.isOverloaded()) {
		return (this.ocd_targdelay * 3);
	} else {
		return (CODEL_LAST_EMPTY_BOUND);
	}
};

OriginalCoDel.prototype.isOverloaded = function () {
	var now = mod_utils.currentMillis();

	return (this.ocd_last_empty < (now - CODEL_LAST_EMPTY_BOUND));
};
