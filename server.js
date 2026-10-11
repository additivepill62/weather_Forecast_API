require('dotenv').config();
const express = require("express")
const cors = require('cors')
const mysql = require("mysql")
const app = express();
const port = process.env.APP_PORT || 3000

const pwdRegExp = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
const emailRegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dateRegExp = /^\d{4}-\d{2}-\d{2}$/;

var pool = mysql.createPool({
    connectionLimit:    Number(process.env.DB_CONN_LIMIT) || 10,
    multipleStatements: process.env.DB_MULTI === 'true',
    host:               process.env.DB_HOST,
    user:               process.env.DB_USER,
    password:           process.env.DB_PASS,
    port:               Number(process.env.DB_PORT) || 3306,
    database:           process.env.DB_NAME,
    timezone:           process.env.DB_TIMEZONE,
    dateStrings:        true, //a DATE oszlop 'YYYY-MM-DD' stringként jön vissza (nincs időzóna-csúszás)
    typeCast: (field, next) => { //a DECIMAL oszlopok számként jöjjenek vissza, ne stringként
        if (field.type === 'NEWDECIMAL') {
            const val = field.string()
            return val === null ? null : parseFloat(val)
        }
        return next()
    }
});
app.use(cors()) //Access-Control-Allow-Origin
app.use(express.urlencoded({extended: true})) //ettől működik a req.body
app.use(express.json()); //kommunikáció json formában

app.get('/', (req, res) => {
    res.send('Welcome to the Weather Forecast API!');
})


//HELPERS -------------------------------

//a bejelentkezett user ellenőrzése (létezik-e, nincs-e letiltva) - callback-et hív a user adataival
function getActiveUser(luid, res, tag, callback){
    pool.query('SELECT ID, name, email, role, status FROM users WHERE ID=?', [luid], (error, results)=>{
        if(error){
            return res.status(500).json({error: '['+tag+'AuthDBError] Database query error'})
        }
        if(results.length == 0){
            return res.status(400).json({error: '['+tag+'AuthIDNonexistent] User with this ID doesn\'t exist!'})
        }
        if(results[0].status == 0){
            return res.status(403).json({error: '['+tag+'AuthUserBanned] This user has been banned by admin!'})
        }
        callback(results[0])
    })
}

//a bejelentkezett user admin-e?
function getAdmin(luid, res, tag, callback){
    getActiveUser(luid, res, tag, (user)=>{
        if(user.role != 'admin'){
            return res.status(403).json({error: '['+tag+'PermissionDenied] You don\'t have permission to use this function!'})
        }
        callback(user)
    })
}

function isBlank(value){
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

//opcionális szűrők (date, location) -> WHERE feltétel
function buildForecastFilter(source){
    const conditions = []
    const params = []
    if(!isBlank(source.date)){
        conditions.push('`date` = ?')
        params.push(source.date)
    }
    if(!isBlank(source.location)){
        conditions.push('location LIKE ?')
        params.push('%' + source.location + '%')
    }
    return {
        where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '',
        params: params
    }
}

//[min, max] határok a numerikus mezőkhöz
const NUMERIC_RULES = {
    temp_min:                  [-90, 60],
    temp_max:                  [-90, 60],
    precipitation:             [0, 1000],   //mm
    precipitation_probability: [0, 100],    //%
    wind_speed:                [0, 500],    //km/h
    humidity:                  [0, 100],    //%
    pressure:                  [800, 1100], //hPa
    uv_index:                  [0, 20]
}

//előrejelzés validálása: {error} vagy {data} (megtisztított adatokkal)
function validateForecast(f){
    if(isBlank(f.date) || isBlank(f.location) || isBlank(f.temp_min) || isBlank(f.temp_max) || isBlank(f.weather_type)){
        return {error: '[FORECASTMissingFields] date, location, temp_min, temp_max and weather_type are required'}
    }

    const date = String(f.date).trim().slice(0, 10)
    const parsed = new Date(date + 'T00:00:00Z')
    if(!dateRegExp.test(date) || isNaN(parsed) || parsed.toISOString().slice(0, 10) !== date){
        return {error: '[FORECASTDateError] Invalid date, use the YYYY-MM-DD format'}
    }

    const location = String(f.location).trim()
    if(location.length > 100){
        return {error: '[FORECASTLocationError] The location can be 100 characters at most'}
    }

    const weather_type = String(f.weather_type).trim()
    if(weather_type.length > 30){
        return {error: '[FORECASTWeatherTypeError] The weather_type can be 30 characters at most'}
    }

    let wind_direction = null
    if(!isBlank(f.wind_direction)){
        wind_direction = String(f.wind_direction).trim()
        if(wind_direction.length > 10){
            return {error: '[FORECASTWindDirectionError] The wind_direction can be 10 characters at most'}
        }
    }

    const data = {date, location, weather_type, wind_direction}

    for(const field in NUMERIC_RULES){
        const [min, max] = NUMERIC_RULES[field]
        if(isBlank(f[field])){
            data[field] = null
            continue
        }
        const n = Number(f[field])
        if(!Number.isFinite(n) || n < min || n > max){
            return {error: '[FORECASTValueError] The ' + field + ' must be a number between ' + min + ' and ' + max}
        }
        data[field] = n
    }

    if(data.temp_min > data.temp_max){
        return {error: '[FORECASTTempError] The temp_min cannot be higher than the temp_max'}
    }

    return {data}
}


//USERS ENDPOINTS -------------------------------

//register
app.post('/users/register', (req, res) =>{
    const {name, email, password, confirm} = req.body;

    //VALIDATE
    if(!name || !email || !password || !confirm){
        return res.status(400).json({error: '[REGISTERMissingFields] Missing required fields'})
    }
    if(name.length > 100){
        return res.status(400).json({error: '[REGISTERNameLength] The name can be 100 characters at most'})
    }
    if(!emailRegExp.test(email)){
        return res.status(400).json({error: '[REGISTEREmailFormat] Invalid e-mail format'})
    }
    if(password !== confirm){
        return res.status(400).json({error: '[REGISTERPasswordMatch] Passwords do not match'})
    }
    if(!password.match(pwdRegExp)){
        return res.status(400).json({error: '[REGISTERRegexError] Password is too weak'})
    }

    //check if email already exists
    pool.query('SELECT ID FROM users WHERE email = ?', [email], (error, results) =>{
        if (error){
            return res.status(500).json({error: '[REGISTEREmailCheckDBError] Database query error'})
        }
        if(results.length > 0){
            return res.status(400).json({error: '[REGISTEREmailCheckExistError] This e-mail already exists'})
        }

        pool.query('INSERT INTO users (name, email, passwd, role) VALUES (?, ?, SHA1(?), "user")', [name, email, password], (error, results) => {
            if(error){
                return res.status(500).json({error: '[REGISTERDBInsertError] Database insertion error'})
            }
            return res.status(201).json({message: '[REGISTERDBInsertSuccess] User registered successfully'})
        });
    })
})

//login
app.post('/users/login', (req, res) =>{
    const {email, password} = req.body

    if (!email || !password){
        return res.status(400).json({error: '[LOGINFieldError] Missing required fields'})
    }

    pool.query('SELECT * FROM users WHERE email=? AND passwd=SHA1(?)', [email, password], (error, results)=>{
        if (error){
            return res.status(500).json({error: '[LOGINEmailPwCheckError] Database query error'})
        }
        if(results.length == 0){
            return res.status(400).json({error: '[LOGINCredentialsError] Invalid credentials!'})
        }

        //LOGIN ban check
        if(results[0].status == 0){
            return res.status(403).json({error: '[LOGINUserHasBeenBanned] This user has been banned by admin!'})
        }

        const loggedUser = {
            ID: results[0].ID,
            name: results[0].name,
            email: results[0].email,
            role: results[0].role
        }

        //LOGIN UPDATE TIMESTAMP + COUNTER
        pool.query('UPDATE users SET `last`=CURRENT_TIMESTAMP, loginCount=loginCount+1 WHERE ID=?', [loggedUser.ID], (error, results)=>{
            if (error){
                return res.status(500).json({error: '[LOGINUpdateTimestampError] Database query error'})
            }
            return res.status(200).json({message: '[LOGINSuccess] You are successfully logged in!', loggedUser})
        })
    })
})

//logout - nem kell rá endpoint, a frontend törli a tárolt user adatokat

//changepassword
app.post('/users/:uid/changepassword', (req, res)=>{
    const {oldpass, newpass, confirm, luid} = req.body
    const uid = req.params.uid

    if(!luid || !oldpass || !newpass || !confirm){
        return res.status(400).json({error: '[CHANGEPWMissingFields] Missing required fields'})
    }
    if(uid != luid){
        return res.status(403).json({error: '[CHANGEPWPermissionError] You don\'t have permission to change this user\'s password'})
    }
    if(newpass !== confirm){
        return res.status(400).json({error: '[CHANGEPWConfirmMatchError] The new password and the confirm does not match!'})
    }
    if(oldpass === newpass){
        return res.status(400).json({error: '[CHANGEPWOldMatchError] The new and old password cannot match!'})
    }
    if(!newpass.match(pwdRegExp)){
        return res.status(400).json({error: '[CHANGEPWRegexError] Password is too weak'})
    }

    getActiveUser(luid, res, 'CHANGEPW', ()=>{
        pool.query('SELECT ID FROM users WHERE ID=? AND passwd=SHA1(?)', [uid, oldpass], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[CHANGEPWOldCheckDBError] Database query error'})
            }
            if(results.length == 0){
                return res.status(400).json({error: '[CHANGEPWOldIncorrect] The old password is not correct'})
            }

            pool.query('UPDATE users SET passwd=SHA1(?) WHERE ID=?', [newpass, uid], (error, results)=>{
                if(error){
                    return res.status(500).json({error: '[CHANGEPWUpdateError] Database query error'})
                }
                return res.status(200).json({message: '[CHANGEPWUpdateSuccess] The password has been successfully changed'})
            })
        })
    })
});

//get profile  (GET /users/5?luid=5)
app.get('/users/:uid', (req, res)=>{
    const uid = req.params.uid
    const luid = req.query.luid

    if(!uid || !luid){
        return res.status(400).json({error: '[GETProfileMissingIDError] Missing user identifier'})
    }
    if(uid != luid){
        return res.status(403).json({error: '[GETProfilePermissionError] You don\'t have permission to view this profile'})
    }

    pool.query('SELECT name, email, role, reg, `last`, loginCount FROM users WHERE ID=?', [uid], (error, results)=>{
        if(error){
            return res.status(500).json({error: '[GETProfileDBError] Database query error'})
        }
        if(results.length == 0){
            return res.status(400).json({error: '[GETProfileError] There is no user that exists with this ID'})
        }
        return res.status(200).json({results: results[0]})
    })
})

//update profile (name + email)
app.patch('/users/:uid', (req, res)=>{
    const uid = req.params.uid
    const {luid} = req.body
    const name = req.body.name || req.body.username //a minta "username"-et használ, mindkettő jó
    const email = req.body.email

    if(!uid || !name || !email || !luid){
        return res.status(400).json({error: '[PATCHUserUpdateFieldError] Missing required fields'})
    }
    if(uid != luid){
        return res.status(403).json({error: '[PATCHUserProfilePermissionError] You don\'t have permission to update this user\'s data'})
    }
    if(name.length > 100){
        return res.status(400).json({error: '[PATCHUserNameLength] The name can be 100 characters at most'})
    }
    if(!emailRegExp.test(email)){
        return res.status(400).json({error: '[PATCHUserEmailFormat] Invalid e-mail format'})
    }

    pool.query('SELECT * FROM users WHERE ID=?', [uid], (error, results)=>{
        if(error){
            return res.status(500).json({error: '[PATCHUserError] Database query error'})
        }
        if(results.length == 0){
            return res.status(400).json({error: '[PATCHUserMissingError] There is no user with this ID in the Database!'})
        }
        if(results[0].status == 0){
            return res.status(403).json({error: '[PATCHUserBanned] This user has been banned by admin!'})
        }
        if(name == results[0].name && email == results[0].email){
            return res.status(200).json({message: '[PATCHUserDataUnchanged] No update occured!'})
        }

        pool.query('SELECT ID FROM users WHERE email=? AND ID<>?', [email, uid], (error2, results2)=>{
            if(error2){
                return res.status(500).json({error: '[PATCHUserEmailCheck] Database query error'})
            }
            if(results2.length > 0){
                return res.status(400).json({error: '[PATCHEmailInUse] This email address is already in use'})
            }

            pool.query('UPDATE users SET name=?, email=? WHERE ID=?', [name, email, uid], (error3, results3)=>{
                if(error3){
                    return res.status(500).json({error: '[PATCHUserUpdateError] Database query error'})
                }
                return res.status(200).json({message: '[PATCHUserUpdateSuccess] User\'s data has been updated successfully'})
            })
        })
    })
})


//FORECASTS ENDPOINTS -------------------------------

//GUEST: csak location, temp_min, temp_max, weather_type  (opcionális szűrők: ?date=YYYY-MM-DD&location=...)
app.get('/forecasts', (req, res)=>{
    const filter = buildForecastFilter(req.query)

    pool.query('SELECT location, temp_min, temp_max, weather_type FROM weather_forecasts' + filter.where + ' ORDER BY `date`, location', filter.params, (error, results)=>{
        if(error){
            return res.status(500).json({error: '[GETForecastsPublicDBError] Database select error'})
        }
        return res.status(200).json({results: results})
    })
})

//USER / ADMIN: teljes lista (body: luid, opcionális date, location szűrők)
app.post('/forecasts/all', (req, res)=>{
    const {luid} = req.body

    if(!luid){
        return res.status(400).json({error: '[GETForecastsFieldError] Missing required fields!'})
    }

    getActiveUser(luid, res, 'GETForecasts', ()=>{
        const filter = buildForecastFilter(req.body)

        pool.query('SELECT * FROM weather_forecasts' + filter.where + ' ORDER BY `date`, location', filter.params, (error, results)=>{
            if(error){
                return res.status(500).json({error: '[GETForecastsDBError] Database select error'})
            }
            return res.status(200).json({results: results})
        })
    })
})

//USER / ADMIN: egy nap részletes adatai
app.post('/forecasts/:fid/details', (req, res)=>{
    const fid = req.params.fid
    const {luid} = req.body

    if(!fid || !luid){
        return res.status(400).json({error: '[GETForecastDetailsFieldError] Missing required fields!'})
    }

    getActiveUser(luid, res, 'GETForecastDetails', ()=>{
        pool.query('SELECT * FROM weather_forecasts WHERE ID=?', [fid], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[GETForecastDetailsDBError] Database select error'})
            }
            if(results.length == 0){
                return res.status(404).json({error: '[GETForecastDetailsNonexistent] There is no forecast with this ID'})
            }
            return res.status(200).json({results: results[0]})
        })
    })
})


//ADMIN ENDPOINTS -------------------------------

//get all forecasts (admin táblázat)
app.post('/admin/forecasts/list', (req, res)=>{
    const {luid} = req.body

    if(!luid){
        return res.status(400).json({error: '[POSTAdminForecastsFieldError] Missing required fields!'})
    }

    getAdmin(luid, res, 'POSTAdminForecasts', ()=>{
        pool.query('SELECT * FROM weather_forecasts ORDER BY `date` DESC, location', (error, results)=>{
            if(error){
                return res.status(500).json({error: '[POSTAdminForecastsDBError] Database select error'})
            }
            return res.status(200).json({results: results})
        })
    })
})

//create forecast
app.post('/admin/forecasts', (req, res)=>{
    const {luid} = req.body

    if(!luid){
        return res.status(400).json({error: '[CREATEForecastFieldError] Missing required fields!'})
    }

    getAdmin(luid, res, 'CREATEForecast', ()=>{
        const checked = validateForecast(req.body)
        if(checked.error){
            return res.status(400).json({error: checked.error})
        }
        const f = checked.data

        pool.query('SELECT ID FROM weather_forecasts WHERE `date`=? AND location=?', [f.date, f.location], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[CREATEForecastExistsCheckError] Database query error'})
            }
            if(results.length > 0){
                return res.status(400).json({error: '[CREATEForecastExists] There is already a forecast for this location and date'})
            }

            pool.query(
                'INSERT INTO weather_forecasts (`date`, location, temp_min, temp_max, weather_type, precipitation, precipitation_probability, wind_speed, wind_direction, humidity, pressure, uv_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [f.date, f.location, f.temp_min, f.temp_max, f.weather_type, f.precipitation, f.precipitation_probability, f.wind_speed, f.wind_direction, f.humidity, f.pressure, f.uv_index],
                (error, results)=>{
                    if(error){
                        return res.status(500).json({error: '[CREATEForecastInsertError] Database insert error'})
                    }
                    return res.status(201).json({message: '[CREATEForecastSuccess] Forecast has been successfully added', ID: results.insertId})
                }
            )
        })
    })
})

//update forecast (részleges módosítás: csak a küldött mezők változnak)
app.patch('/admin/forecasts/:fid', (req, res)=>{
    const fid = req.params.fid
    const {luid} = req.body

    if(!fid || !luid){
        return res.status(400).json({error: '[UPDATEForecastFieldError] Missing required fields!'})
    }

    getAdmin(luid, res, 'UPDATEForecast', ()=>{
        pool.query('SELECT * FROM weather_forecasts WHERE ID=?', [fid], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[UPDATEForecastSelectError] Database select error'})
            }
            if(results.length == 0){
                return res.status(404).json({error: '[UPDATEForecastNonexistent] There is no forecast with this ID'})
            }

            //a régi adatok + a body-ban érkező módosítások
            const merged = Object.assign({}, results[0])
            for(const field of Object.keys(merged)){
                if(field !== 'ID' && req.body[field] !== undefined){
                    merged[field] = req.body[field]
                }
            }

            const checked = validateForecast(merged)
            if(checked.error){
                return res.status(400).json({error: checked.error})
            }
            const f = checked.data

            pool.query('SELECT ID FROM weather_forecasts WHERE `date`=? AND location=? AND ID<>?', [f.date, f.location, fid], (error2, results2)=>{
                if(error2){
                    return res.status(500).json({error: '[UPDATEForecastExistsCheckError] Database query error'})
                }
                if(results2.length > 0){
                    return res.status(400).json({error: '[UPDATEForecastExists] There is already a forecast for this location and date'})
                }

                pool.query(
                    'UPDATE weather_forecasts SET `date`=?, location=?, temp_min=?, temp_max=?, weather_type=?, precipitation=?, precipitation_probability=?, wind_speed=?, wind_direction=?, humidity=?, pressure=?, uv_index=?, updated_at=CURRENT_TIMESTAMP WHERE ID=?',
                    [f.date, f.location, f.temp_min, f.temp_max, f.weather_type, f.precipitation, f.precipitation_probability, f.wind_speed, f.wind_direction, f.humidity, f.pressure, f.uv_index, fid],
                    (error3, results3)=>{
                        if(error3){
                            return res.status(500).json({error: '[UPDATEForecastError] Database update error'})
                        }
                        return res.status(200).json({message: '[UPDATEForecastSuccess] Forecast has been successfully modified'})
                    }
                )
            })
        })
    })
})

//delete forecast
app.delete('/admin/forecasts/:fid', (req, res)=>{
    const fid = req.params.fid
    const {luid} = req.body

    if(!fid || !luid){
        return res.status(400).json({error: '[DELETEForecastFieldError] Missing required fields!'})
    }

    getAdmin(luid, res, 'DELETEForecast', ()=>{
        pool.query('DELETE FROM weather_forecasts WHERE ID=?', [fid], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[DELETEForecastError] Database delete error'})
            }
            if(results.affectedRows == 0){
                return res.status(404).json({error: '[DELETEForecastNonexistent] There is no forecast with this ID'})
            }
            return res.status(200).json({message: '[DELETEForecastSuccess] Forecast has been successfully deleted'})
        })
    })
})

// get all users (jelszó hash nélkül)
app.post('/admin/users', (req, res) =>{
    const luid = req.body.luid;

    if (!luid) {
        return res.status(400).json({ error: '[POSTUsersFieldError] Missing required fields!' });
    }

    getAdmin(luid, res, 'POSTUsers', ()=>{
        pool.query('SELECT ID, name, email, role, status, reg, `last`, loginCount FROM users ORDER BY ID', (error, results) => {
            if (error) {
                return res.status(500).json({ error: '[POSTUsersDBError] Database query error' });
            }
            return res.status(200).json(results);
        });
    })
});

//ban / unban user (a státusz átváltása: 1 <-> 0)
app.post('/admin/status', (req, res)=>{
    const {uid, luid} = req.body

    if(!uid || !luid){
        return res.status(400).json({error: '[POSTDenyUserFieldError] Missing required fields'})
    }
    if(uid == luid){
        return res.status(400).json({error: '[POSTDenyUserSelf] You can\'t change your own status!'})
    }

    getAdmin(luid, res, 'POSTDenyUser', ()=>{
        pool.query('SELECT ID, role, status FROM users WHERE ID=?', [uid], (error, results)=>{
            if(error){
                return res.status(500).json({error: '[POSTDenyUserSelectError] Database query error'})
            }
            if(results.length == 0){
                return res.status(400).json({error: '[POSTDenyUserUIDNonexistent] No user exists with this ID'})
            }
            if(results[0].role == 'admin'){
                return res.status(403).json({error: '[POSTDenyUserAdminProtected] You can\'t ban another admin!'})
            }

            const newStatus = results[0].status == 1 ? 0 : 1

            pool.query('UPDATE users SET status=? WHERE ID=?', [newStatus, uid], (error2, results2)=>{
                if(error2){
                    return res.status(500).json({error: '[POSTDenyUserUpdateError] Database query error'})
                }
                return res.status(200).json({
                    message: newStatus == 0 ? '[POSTUserBanned] User has been banned' : '[POSTUserUnbanned] User has been unbanned',
                    status: newStatus
                })
            })
        })
    })
})


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
