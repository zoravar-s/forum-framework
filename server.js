require("dotenv").config()
const jwt = require("jsonwebtoken")
const marked = require("marked")
const sanitizeHTML = require("sanitize-html")
const bcrypt = require("bcrypt")
const cookieParser = require("cookie-parser")
const express = require("express")
const db = require("better-sqlite3")("App.db")

const multer = require("multer")
const uploadpfp = multer({dest: 'profiles/'})
db.pragma("journal_mode = WAL")

// database shit

const createTables = db.transaction(() => {

    // user handler

    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username STRING NOT NULL UNIQUE,
        password STRING NOT NULL,
        banned BIT
        )
        `).run()

    // user profile data handler

    db.prepare(`
        CREATE TABLE IF NOT EXISTS userdata (
        authorid INTEGER PRIMARY KEY,
        userJoin TEXT,
        bio TEXT,
        isAdmin BIT,
        FOREIGN KEY (authorid) REFERENCES users (id) ON DELETE CASCADE
        )
        `).run()


    // individual posts handler

    db.prepare(`
        CREATE TABLE IF NOT EXISTS userposts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        createdDate TEXT,
        title STRING NOT NULL,
        body TEXT NOT NULL,
        authorid INTEGER,
        likes INTEGER,
        FOREIGN KEY (authorid) REFERENCES users (id) ON DELETE CASCADE
        )
        `).run()

    // post comments handler

    db.prepare(`
        CREATE TABLE IF NOT EXISTS usercomments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        createdDate TEXT,
        body TEXT NOT NULL,
        parentPost INTEGER,
        authorid INTEGER,
        likes INTEGER,
        FOREIGN KEY (parentPost) REFERENCES userposts (id) ON DELETE CASCADE
        )
        `).run()

    // post likes handler

    db.prepare(`
    CREATE TABLE IF NOT EXISTS postLikes (
    userId INTEGER REFERENCES users(id) ON DELETE CASCADE,
    postId INTEGER REFERENCES userposts(id) ON DELETE CASCADE,
    PRIMARY KEY (userId, postId)
    )
    `).run()

    // comment likes handler

    db.prepare(`
    CREATE TABLE IF NOT EXISTS commentLikes (
    userId INTEGER REFERENCES users(id) ON DELETE CASCADE,
    commentId INTEGER REFERENCES usercomments(id) ON DELETE CASCADE,
    PRIMARY KEY (userId, commentId)
    )
    `).run()

    // friends handler

    db.prepare(`
    CREATE TABLE IF NOT EXISTS friends (
    friend1 INTEGER REFERENCES users(id) ON DELETE CASCADE,
    friend2 INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status INTEGER,
    createdDate TEXT,
    PRIMARY KEY (friend1, friend2)
    )
    `).run()

    // messages handler

    db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender INTEGER REFERENCES users(id) ON DELETE CASCADE,
    recipient INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title STRING NOT NULL,
    body TEXT NOT NULL,   
    type INTEGER NOT NULL,
    createdDate TEXT,
    FOREIGN KEY (sender) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (recipient) REFERENCES users (id) ON DELETE CASCADE
    )
    `).run()

})

createTables()

//

const app = express()

app.set("view engine", "ejs")
app.use(express.urlencoded({extended: false}))
app.use(express.static("public"))
app.use(cookieParser())

app.use(function (req, res, next) {

    // allow markdowns

    res.locals.filterUserHTML = function(content) {
        return sanitizeHTML(marked.parse(content), {
            allowedTags: ["p","br","ul","li","ol","strong","bold","i","em","h1","h2","h3","h4","h5","h6"],
            allowedAttributes: {}
        })
    }


    res.locals.errors = []

    // decode cookie

    try{
        const decoded = jwt.verify(req.cookies.loginCookie, process.env.JWTSECRET)
        req.user = decoded
    } catch(err) {
        req.user = false
    }

    // check if user is banned

    if (req.user) {
        const banStatement = db.prepare("SELECT banned FROM users WHERE id = ?")
        const bannedStatement = (banStatement.get(req.user.userid))['banned']
        if ((bannedStatement == 1) && ((req.url).toString() !== "/logout")) {
            return res.render("banned")
        }
    }

    res.locals.user = req.user
    next()
})

app.get("/", (req, res) => {
    if (req.user) {
        const postStatements = db.prepare("SELECT * FROM userposts WHERE authorid = ? ORDER BY createdDate DESC LIMIT 3")
        const userposts = postStatements.all(req.user.userid)
        const infoStatements = db.prepare("SELECT * FROM userdata WHERE authorid = ?")
        const info = infoStatements.get(req.user.userid)
        return res.render("dashboard", {userposts, info})
    }
    return res.render("homepage")
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

app.get("/login", (req, res) => {
    res.render("login")
})

app.get("/logout", (req, res) => {
    res.clearCookie("loginCookie")
    res.redirect("/signup")
})

// posting

function loginChecker(req,res,next) {
    if (req.user) {
        return next()
    }
    return res.redirect("/")
}

app.get("/create-post", loginChecker, (req, res) => {
    res.render("create-post")
})

function sharedPostValidation(req) {
    const errors = []

    if (typeof req.body.title !== "string") req.body.title = ""
    if (typeof req.body.body !== "string") req.body.body = ""

    // strip attempted fucking around

    req.body.title = sanitizeHTML(req.body.title.trim(), {allowedTags: [], allowedAttributes: {}})
    req.body.body = sanitizeHTML(req.body.body.trim(), {allowedTags: [], allowedAttributes: {}})

    if (!req.body.title) errors.push("Please provide a title.")
    if (!req.body.body) errors.push("Please provide a post.") 
        
    if (req.body.body && req.body.body.length > 2500) errors.push("It's wonderful that you have so many things to say about yourself, but your message must be under 2500 characters.")
    if (req.body.title && req.body.title.length > 50) errors.push("It's wonderful that you have so many things to say about yourself, but your title must be under 50 characters.")

    return errors
}

function sharedCommentValidation(req) {
    const errors = []

    if (typeof req.body.body !== "string") req.body.body = ""

    // strip attempted fucking around

    req.body.body = sanitizeHTML(req.body.body.trim(), {allowedTags: [], allowedAttributes: {}})

    if (!req.body.body) errors.push("Please provide a comment.")   
    if (req.body.body && req.body.body.length > 1000) errors.push("It's wonderful that you have so many things to say, but your comment must be under 1500 characters.")  

    return errors
}

// friends


app.get("/outbound-friends/page:page", loginChecker, (req, res) => {
    const pagenum = req.params.page
    const postStatements = db.prepare(`SELECT
        m.*,
        sender.username AS sender_username,
        recipient.username AS recipient_username
    FROM friends AS m
    JOIN users AS sender
        ON m.friend1 = sender.id
    JOIN users AS recipient
        ON m.friend2 = recipient.id
    WHERE (m.friend1 = ?) AND m.status = 0 ORDER BY createdDate DESC LIMIT ? OFFSET ?;`)
    const requests = postStatements.all(req.user.userid, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM friends WHERE (friend1 = ? AND status = 0)")
    const requestsLength = (lengthStatements.get(req.user.userid))['COUNT(*)']

    if (pagenum > Math.ceil(requestsLength/10)) {
        return res.redirect(`/outbound-friends/page${Math.ceil(requestsLength/10)}`)
    }
    
    return res.render("outbound-friends", {requests, pagenum, requestsLength})
})

app.get("/inbound-friends/page:page", loginChecker, (req, res) => {
    const pagenum = req.params.page
    const postStatements = db.prepare(`SELECT
        m.*,
        sender.username AS sender_username,
        recipient.username AS recipient_username
    FROM friends AS m
    JOIN users AS sender
        ON m.friend1 = sender.id
    JOIN users AS recipient
        ON m.friend2 = recipient.id
    WHERE (m.friend2 = ?) AND m.status = 0 ORDER BY createdDate DESC LIMIT ? OFFSET ?;`)
    const requests = postStatements.all(req.user.userid, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM friends WHERE (friend2 = ? AND status = 0)")
    const requestsLength = (lengthStatements.get(req.user.userid))['COUNT(*)']

    if (pagenum > Math.ceil(requestsLength/10)) {
        return res.redirect(`/inbound-friends/page${Math.ceil(requestsLength/10)}`)
    }
    
    return res.render("inbound-friends", {requests, pagenum, requestsLength})
})



app.post("/add-friend/:id", loginChecker, (req, res) => {
    // Don't friend yourself

    const errors = []

    if (req.user.userid == req.params.id) {
        errors.push("You can't friend yourself...")
    }

    // Check user exists
    const checkIfUserExists = db.prepare("SELECT * FROM users WHERE id = ?")
    const friendingUser = checkIfUserExists.get(req.params.id)

    if (!friendingUser) {
        return res.redirect("/")    
    }
    // Check if there's already a friend request
    const checkIfAlreadySent = db.prepare("SELECT * FROM friends WHERE (friend1 = ? AND friend2 = ?) OR (friend2 = ? AND friend1 = ?)")
    const AlreadySent = checkIfAlreadySent.get(req.params.id, req.user.userid, req.params.id, req.user.userid)

    if (AlreadySent) {
        // Check if user in question has sent a friend request (then accept it)
        const checkIfRequest = db.prepare("SELECT * FROM friends WHERE (friend1 = ? AND friend2 = ? AND status = 0)")
        const realRequest = checkIfRequest.get(req.params.id, req.user.userid)
        if (realRequest) {
            const acceptRequest = db.prepare("UPDATE friends SET status = 1 WHERE (friend1 = ? AND friend2 = ?)")
            const Accepter = acceptRequest.run(req.params.id, req.user.userid)
            return res.redirect(`/profile/${req.params.id}/page1`)
        }

        // Else ignore

        errors.push("You can't friend yourself...")
    }

    if (errors.length) {
        return res.redirect("/") // i don't care enough for an error page
    }

    // Assume friend request available

    const SummonFriendReq = db.prepare("INSERT INTO friends (friend1, friend2, status, createdDate) VALUES (?,?,?,?)")

    // fyi friend1 is sender, friend2 is reciever dumbass. should've named it well

    const Request = SummonFriendReq.run(req.user.userid,req.params.id,0,new Date().toISOString())
    
    res.redirect(`/profile/${req.params.id}/page1`)

})



app.post("/remove-friend/:id", loginChecker, (req, res) => {
    
    // Don't friend yourself

    const errors = []

    if (req.user.userid == req.params.id) {
        errors.push("You can't unfriend yourself...")
    }

    // Check user exists
    const checkIfUserExists = db.prepare("SELECT * FROM users WHERE id = ?")
    const friendingUser = checkIfUserExists.get(req.params.id)

    if (!friendingUser) {
        return res.redirect("/")    
    }
    // Check if there's already a friend request
    const checkIfAlreadySent = db.prepare("SELECT * FROM friends WHERE ((friend2 = ? AND friend1 = ?) OR (friend1 = ? AND friend2 = ?))")
    const AlreadySent = checkIfAlreadySent.get(req.params.id, req.user.userid, req.params.id, req.user.userid)

    // Destroy friend (haha) if already friended

    if (AlreadySent) {
        const destroyFriendRequest = db.prepare("DELETE FROM friends WHERE ((friend2 = ? AND friend1 = ?) OR (friend1 = ? AND friend2 = ?))")
        const destroyFriend = destroyFriendRequest.run(req.params.id, req.user.userid, req.params.id, req.user.userid)
        return res.redirect(`/profile/${req.params.id}/page1`) 
    }

    if (errors.length) {
        return res.redirect("/") // i don't care enough for an error page
    }

    return res.redirect("/")

})



// post editing




app.get("/edit-post/:id", (req, res) => {
    const statement = db.prepare("SELECT * FROM userposts WHERE id = ?")
    const post = statement.get(req.params.id)

    if (!post) {
        return res.redirect("/")
    }

    if (post.authorid !== req.user.userid) {
        return res.redirect("/")
    }

    res.render("edit-post", {post})

})

app.post("/edit-post/:id", loginChecker, (req, res) => {
    const statement = db.prepare("SELECT * FROM userposts WHERE id = ?")
    const post = statement.get(req.params.id)

    if (!post) {
        return res.redirect("/")
    }

    if (post.authorid !== req.user.userid) {
        return res.redirect("/")
    }

    const errors = sharedPostValidation(req)
    if (errors.length) {
        return res.render("edit-post", {errors})
    }

    const updateStatement = db.prepare("UPDATE userposts SET title = ?, body = ? WHERE id = ?")
    updateStatement.run(req.body.title, req.body.body, req.params.id)

    res.redirect(`/post/${req.params.id}`)

})

app.post("/delete-post/:id", loginChecker, (req, res) => {
    const statement = db.prepare("SELECT * FROM userposts WHERE id = ?")
    const post = statement.get(req.params.id)

    if (!post) {
        return res.redirect("/")
    }

    if (post.authorid !== req.user.userid) {
        return res.redirect("/")
    }

    const deleteStatement = db.prepare("DELETE FROM userposts WHERE id = ?") // cascades (deletes comments)
    deleteStatement.run(req.params.id)

    res.redirect("/")
})

app.get("/post/:id", (req,res) => {
    const statement = db.prepare("SELECT userposts.*, users.username FROM userposts INNER JOIN users ON userposts.authorid = users.id WHERE userposts.id = ?")
    const post = statement.get(req.params.id)
    const errors = req.params.err
    const pagenum = 1

    if(!post) {
        return res.redirect("/")
    }

    const commentStatements = db.prepare(`SELECT
        usercomments.*,
        users.username,
        CASE
            WHEN commentLikes.commentId IS NOT NULL THEN 1
            ELSE 0
        END AS likedByCurrentUser
    FROM usercomments
    INNER JOIN users
        ON usercomments.authorid = users.id
    LEFT JOIN commentLikes
        ON commentLikes.commentId = usercomments.id
        AND commentLikes.userId = ?
    WHERE usercomments.parentPost = ?
    ORDER BY createdDate DESC
    LIMIT ? OFFSET ?`)
    
    const comments = commentStatements.all(req.user.userid, req.params.id, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM usercomments INNER JOIN users ON usercomments.authorid = users.id WHERE usercomments.parentPost = ?")
    const commentslength = (lengthStatements.get(req.params.id))['COUNT(*)']

    const isAuthor = post.authorid === req.user.userid
    let loggedin = false

    if (req.user) {
        loggedin = true
    }

    const likesStatement = db.prepare(`
    SELECT EXISTS (
    SELECT 1 
    FROM postLikes
    WHERE userId = ?
    AND postId = ?
    ) AS user_has_liked;`)
    
    const userLiked = (likesStatement.get(req.user.userid, req.params.id))['user_has_liked']

    res.render("single-post", {post, isAuthor, comments, loggedin, pagenum, commentslength, userLiked})
})


app.post("/like-post/:id", (req,res) => {
    const likesStatement = db.prepare(`
    SELECT EXISTS (
    SELECT 1 
    FROM postLikes
    WHERE userId = ?
    AND postId = ?
    ) AS user_has_liked;`)
    
    const userLiked = (likesStatement.get(req.user.userid, req.params.id))['user_has_liked']

    if (userLiked == 0) {
        const fullLikeTransfer = db.transaction((userId, postId) => {
            const updateStatement = db.prepare("INSERT INTO postLikes (userId, postId) VALUES (?,?)")
            const likeStatement =  db.prepare("UPDATE userposts SET likes = likes + 1 WHERE id = ?")

            updateStatement.run(userId, postId)
            likeStatement.run(postId)
        });
        try {
            fullLikeTransfer(req.user.userid,req.params.id)
        } catch(err) {
            console.log(err)
        }
    } else {
        const fullLikeTransfer = db.transaction((userId, postId) => {
            const updateStatement = db.prepare("DELETE FROM postLikes WHERE userId = ? AND postId = ?")
            const likeStatement =  db.prepare("UPDATE userposts SET likes = likes - 1 WHERE id = ?")

            updateStatement.run(userId, postId)
            likeStatement.run(postId)
        });
        try {
            fullLikeTransfer(req.user.userid,req.params.id)
        } catch(err) {
            console.log(err)
        }
    }

    // ACID transaction - ensure no like mismatch and db fuckery

    res.redirect(`/post/${req.params.id}`)
})

app.post("/like-comment/:id/page:page", (req,res) => {
    const likesStatement = db.prepare(`
    SELECT EXISTS (
    SELECT 1 
    FROM commentLikes
    WHERE userId = ?
    AND commentId = ?
    ) AS user_has_liked;`)
    
    const userLiked = (likesStatement.get(req.user.userid, req.params.id))['user_has_liked']

    const parentPostStatement = db.prepare("SELECT parentPost FROM usercomments WHERE id = ?")
    const parentofComment = parentPostStatement.get(req.params.id)

    if (userLiked == 0) {
        const fullLikeTransfer = db.transaction((userId, postId) => {
            const updateStatement = db.prepare("INSERT INTO commentLikes (userId, commentId) VALUES (?,?)")
            const likeStatement =  db.prepare("UPDATE usercomments SET likes = likes + 1 WHERE id = ?")

            updateStatement.run(userId, postId)
            likeStatement.run(postId)
        });
        try {
            fullLikeTransfer(req.user.userid,req.params.id)
        } catch(err) {
            console.log(err)
        }
    } else {
        const fullLikeTransfer = db.transaction((userId, postId) => {
            const updateStatement = db.prepare("DELETE FROM commentLikes WHERE userId = ? AND commentId = ?")
            const likeStatement =  db.prepare("UPDATE usercomments SET likes = likes - 1 WHERE id = ?")

            updateStatement.run(userId, postId)
            likeStatement.run(postId)
        });
        try {
            fullLikeTransfer(req.user.userid,req.params.id)
        } catch(err) {
            console.log(err)
        }
    }

    // ACID transaction - ensure no like mismatch and db fuckery

    res.redirect(`/post/${parentofComment["parentPost"]}/page${req.params.page}`)
})

app.get("/post/:id/page:page", (req,res) => {
    const statement = db.prepare("SELECT userposts.*, users.username FROM userposts INNER JOIN users ON userposts.authorid = users.id WHERE userposts.id = ?")
    const post = statement.get(req.params.id)
    const errors = req.params.err
    const pagenum = req.params.page

    if(!post) {
        return res.redirect("/")
    }

    // SELECT usercomments.*, users.username FROM usercomments INNER JOIN users ON usercomments.authorid = users.id WHERE usercomments.parentPost = ? ORDER BY createdDate DESC LIMIT ? OFFSET ?
    
    const commentStatements = db.prepare(`SELECT
        usercomments.*,
        users.username,
        CASE
            WHEN commentLikes.commentId IS NOT NULL THEN 1
            ELSE 0
        END AS likedByCurrentUser
    FROM usercomments
    INNER JOIN users
        ON usercomments.authorid = users.id
    LEFT JOIN commentLikes
        ON commentLikes.commentId = usercomments.id
        AND commentLikes.userId = ?
    WHERE usercomments.parentPost = ?
    ORDER BY createdDate DESC
    LIMIT ? OFFSET ?`)
    
    const comments = commentStatements.all(req.user.userid, req.params.id, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM usercomments INNER JOIN users ON usercomments.authorid = users.id WHERE usercomments.parentPost = ?")
    const commentslength = (lengthStatements.get(req.params.id))['COUNT(*)']

    const isAuthor = post.authorid === req.user.userid
    let loggedin = false

    if (req.user) {
        loggedin = true
    }

    if (pagenum > Math.ceil(commentslength/10)) {
        return res.redirect(`/post/${req.params.id}/page${Math.ceil(commentslength/10)}`)
    }

    const likesStatement = db.prepare(`
    SELECT EXISTS (
    SELECT 1 
    FROM postLikes
    WHERE userId = ?
    AND postId = ?
    ) AS user_has_liked;`)
    
    const userLiked = (likesStatement.get(req.user.userid, req.params.id))['user_has_liked']

    res.render("single-post", {post, isAuthor, comments, loggedin, pagenum, commentslength, userLiked})
})

app.post("/create-post", loginChecker, (req, res) => {
    const errors = sharedPostValidation(req)

    if (errors.length) {
        return res.render("create-post", {errors})
    }

    // post submitted

    const ourStatement = db.prepare("INSERT INTO userposts (title, body, authorid, createdDate, likes) VALUES (?,?,?,?,?)")
    const result = ourStatement.run(req.body.title, req.body.body, req.user.userid, new Date().toISOString(), 1)

    const getPostStatement = db.prepare("SELECT * FROM userposts WHERE ROWID = ?")
    const realPost = getPostStatement.get(result.lastInsertRowid)

    const likeOwnPost = db.prepare("INSERT INTO postLikes (userId, postId) VALUES (?,?)")
    likeOwnPost.run(req.user.userid, realPost.id)

    res.redirect(`/post/${realPost.id}`)
})

// comments

app.post("/comment-post/:id", loginChecker, (req, res) => {
    const statement = db.prepare("SELECT userposts.*, users.username FROM userposts INNER JOIN users ON userposts.authorid = users.id WHERE userposts.id = ?")
    const post = statement.get(req.params.id)
    const isAuthor = post.authorid === req.user.userid

    if (!post) {
        return res.redirect("/")
    }

    const commentStatements = db.prepare("SELECT usercomments.*, users.username FROM usercomments INNER JOIN users ON usercomments.authorid = users.id WHERE usercomments.parentPost = ? ORDER BY createdDate DESC")
    const comments = commentStatements.all(req.params.id)

    let loggedin = false

    if (req.user) {
        loggedin = true
    }

    const errors = sharedCommentValidation(req)

    const likesStatement = db.prepare(`
    SELECT EXISTS (
    SELECT 1 
    FROM postLikes
    WHERE userId = ?
    AND postId = ?
    ) AS user_has_liked;`)
    
    const userLiked = (likesStatement.get(req.user.userid, req.params.id))['user_has_liked']

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM usercomments INNER JOIN users ON usercomments.authorid = users.id WHERE usercomments.parentPost = ?")
    const commentslength = (lengthStatements.get(post.id))['COUNT(*)']

    const pagenum = 1

    if (errors.length) {
        return res.render("single-post", {post, isAuthor, comments, loggedin, pagenum, commentslength, userLiked, errors})
    }

    const ourStatement = db.prepare("INSERT INTO usercomments (body, authorid, parentPost, createdDate, likes) VALUES (?,?,?,?,?)")
    const result = ourStatement.run(req.body.body, req.user.userid, post.id, new Date().toISOString(), 1)

    const getCommentStatement = db.prepare("SELECT * FROM usercomments WHERE ROWID = ?")
    const realComment = getCommentStatement.get(result.lastInsertRowid)

    const updateStatement = db.prepare("INSERT INTO commentLikes (userId, commentId) VALUES (?,?)")
    updateStatement.run(req.user.userid,realComment.id)
    
    res.redirect(`/post/${req.params.id}`)

})

app.post("/delete-comment/:id", loginChecker, (req, res) => {
    const statement = db.prepare("SELECT * FROM usercomments WHERE id = ?")
    const post = statement.get(req.params.id)

    if (!post) {
        return res.redirect("/")
    }

    if (post.authorid !== req.user.userid) {
        return res.redirect("/")
    }

    const originalPost = post.parentPost

    const deleteStatement = db.prepare("DELETE FROM usercomments WHERE id = ?")
    deleteStatement.run(req.params.id)

    res.redirect(`/post/${originalPost}`)
})

// settings

app.get("/settings", loginChecker, (req, res) => {

    const bioRequest = db.prepare("SELECT bio FROM userdata WHERE authorid = ?")
    const bioMatch = bioRequest.get(req.user.userid)

    const currentBio = bioMatch

    res.render("settings", {currentBio})

})

app.post("/update-bio", loginChecker, (req, res) => {
    let errors = []
    if (typeof req.body.body !== "string") req.body.body = ""

    if (!req.body.body) req.body.body = ""
    if (req.body.body && req.body.body.length > 1000) errors = ["It's wonderful that you have so many things to say about yourself, but your bio must be under 1000 characters."]

    req.body.body = sanitizeHTML(req.body.body.trim(), {allowedTags: [], allowedAttributes: {}})
    
    if (errors.length) {
        const bioRequest = db.prepare("SELECT bio FROM userdata WHERE authorid = ?")
        const bioMatch = bioRequest.get(req.user.userid)

        const currentBio = bioMatch
        return res.render("settings", {currentBio, errors})
    }

    const bioChange = db.prepare("UPDATE userdata SET bio = ? WHERE authorid = ?")
    bioChange.run(req.body.body,req.user.userid)

    res.redirect("/")   
})

app.get("/change-password", loginChecker, (req, res) => {
    res.render("change-password")
})

app.post("/change-password", loginChecker, (req, res) => {
    let errors = []
    if (typeof req.body.password !== "string") req.body.password = ""
    if (typeof req.body.newpassword !== "string") req.body.newpassword = ""
    if (req.body.password.trim() == "" || req.body.newpassword == "") errors = ["Something went wrong, try again."]

    const userRequest = db.prepare("SELECT * FROM users WHERE USERNAME = ?")
    const userMatch = userRequest.get(req.user.username)

    if (!userMatch) {
        errors = ["This error should never ever appear, what the hell have you done?"]
        return res.render("change-password",{errors})
    }

    const match = bcrypt.compareSync(req.body.password, userMatch.password)
    if (!match) {
        errors = ["Your current password is incorrect."]
        return res.render("change-password",{errors})        
    }

    if (!req.body.newpassword) errors = ["Please suggest a new password."]
    if (req.body.newpassword && req.body.newpassword.length < 10) errors = ["Password is too short."]
    if (req.body.newpassword && req.body.newpassword.length > 50) errors = ["Password is too long."]

    if (errors.length) {
        return res.render("change-password", {errors})
    }

    // update

    const salt = bcrypt.genSaltSync(10)
    const newPword = bcrypt.hashSync(req.body.newpassword, salt)

    const statement = db.prepare("UPDATE users SET password = ? WHERE id = ?")
    statement.run(newPword, req.user.userid)

    // sign out

    res.clearCookie("loginCookie")
    res.redirect("/login")

        
})

// login

app.post("/login", (req, res) => {
    let errors = []
    if (typeof req.body.username !== "string") req.body.username = ""
    if (typeof req.body.password !== "string") req.body.password = ""
    if (req.body.username.trim() == "" || req.body.password == "") errors = ["invalid login"]
    
    if (errors.length) {
        return res.render("login", {errors})
    }

    const userRequest = db.prepare("SELECT * FROM users WHERE USERNAME = ?")
    const userMatch = userRequest.get(req.body.username)

    if (!userMatch) {
        errors = ["invalid login"]
        return res.render("login",{errors})
    }

    const match = bcrypt.compareSync(req.body.password, userMatch.password)
    if (!match) {
        errors = ["invalid login"]
        return res.render("login",{errors})        
    }

    // cookie given

    const tokenval = jwt.sign({exp: Math.floor(Date.now() / 1000) + 60*60*24, userid: userMatch.id, username: userMatch.username,},process.env.JWTSECRET)

    res.cookie("loginCookie", tokenval, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24
    })

    res.redirect("/")

        
})


app.post("/register", (req, res) => {
    const errors = []
    if (typeof req.body.username !== "string") req.body.username = ""
    if (typeof req.body.password !== "string") req.body.password = ""

    req.body.username = req.body.username.trim()

    if (!req.body.username) errors.push("username blank.")
    if (req.body.username && req.body.username.length < 3) errors.push("Username too short.")
    if (req.body.username && req.body.username.length > 15) errors.push("Username too long.")
    if (req.body.username && !req.body.username.match(/^[a-zA-Z0-9]+$/)) errors.push("Username has invalid characters.")
    
    if (req.body.password !== req.body.password2) errors.push("Your passwords don't seem to match.")

    // check if user exists already 

    const usernameStatement = db.prepare("SELECT * FROM users WHERE username = ?")
    const usernameCheck = usernameStatement.get(req.body.username)

    if (usernameCheck) errors.push("username is taken")

    if (!req.body.password) errors.push("password blank.")
    if (req.body.password && req.body.password.length < 10) errors.push("Password too short.")
    if (req.body.password && req.body.password.length > 50) errors.push("Password too long.")
        
    if (errors.length) {
        return res.render("signup",{errors})
    }
    
    // data submission

    // hash with salt

    const salt = bcrypt.genSaltSync(10)
    req.body.password = bcrypt.hashSync(req.body.password, salt)

    const statement = db.prepare("INSERT INTO users (username, password, banned) VALUES (?, ?, ?)")
    const result = statement.run(req.body.username, req.body.password, 0)

    const lookupStatement = db.prepare("SELECT * FROM users WHERE ROWID = ?")
    const ourUser = lookupStatement.get(result.lastInsertRowid)

    // set up user data

    const dataStatement = db.prepare("INSERT INTO userdata (authorid, userJoin, bio, isAdmin) VALUES (?, ?, ?, ?)")
    dataStatement.run(ourUser.id, new Date().toISOString(), `Hello, my name is ${ourUser.username}`, 0)

    // cookie

    const tokenval = jwt.sign({exp: Math.floor(Date.now() / 1000) + 60*60*24, userid: ourUser.id, username: ourUser.username,},process.env.JWTSECRET)

    res.cookie("loginCookie", tokenval, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24
    })

    res.redirect("/")
})

// profiles

app.get("/profile/:id/page:page", (req, res) => {
    const userStatements = db.prepare("SELECT * FROM users WHERE id = ?")
    const userIdentifier = userStatements.get(req.params.id)
    const pagenum = req.params.page

    const seeIfFriendRequestPending = db.prepare("SELECT * FROM friends WHERE (friend1 = ? AND friend2 = ?) OR (friend2 = ? AND friend1 = ?)")
    const ifFriends = seeIfFriendRequestPending.get(req.params.id, req.user.userid, req.params.id, req.user.userid)

    const getFriends = db.prepare(`SELECT
        m.*,
        recipient.username AS recipientuser,
        sender.username AS senderuser
    FROM friends AS m
    JOIN users AS sender
        ON m.friend1 = sender.id
    JOIN users AS recipient
        ON m.friend2 = recipient.id
    WHERE (m.friend1 = ? OR m.friend2 = ?) AND m.status = 1 ORDER BY createdDate DESC LIMIT 10;`)
    const friendsPreview = getFriends.all(req.params.id, req.params.id)

    if (userIdentifier) {
        const postStatements = db.prepare("SELECT * FROM userposts WHERE authorid = ? ORDER BY createdDate DESC LIMIT ? OFFSET ?;")
        const userposts = postStatements.all(req.params.id, 10, ((pagenum-1)*10))
        const infoStatements = db.prepare("SELECT * FROM userdata WHERE authorid = ?")
        const info = infoStatements.get(req.params.id)

        const lengthStatements = db.prepare("SELECT COUNT(*) FROM userposts WHERE authorid = ?")
        const commentslength = (lengthStatements.get(req.params.id))['COUNT(*)']

        return res.render("profile", {userIdentifier, userposts, info, commentslength, pagenum, ifFriends, friendsPreview})
    }
    return res.redirect("/")
})

app.get("/profile/:id/friends/page:page", (req, res) => {
    const userStatements = db.prepare("SELECT * FROM users WHERE id = ?")
    const userIdentifier = userStatements.get(req.params.id)
    const pagenum = req.params.page

    const getFriends = db.prepare(`SELECT
        m.*,
        recipient.username AS recipientuser,
        sender.username AS senderuser
    FROM friends AS m
    JOIN users AS sender
        ON m.friend1 = sender.id
    JOIN users AS recipient
        ON m.friend2 = recipient.id
    WHERE (m.friend1 = ? OR m.friend2 = ?) AND m.status = 1 ORDER BY createdDate DESC LIMIT ? OFFSET ?;;`)
    const friends = getFriends.all(req.params.id, req.params.id, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM friends WHERE (friends.friend1 = ? OR friends.friend2 = ?) AND friends.status = 1")
    const requestsLength = (lengthStatements.get(req.params.id, req.params.id))['COUNT(*)']

    if (userIdentifier) {
        if (pagenum > Math.ceil(requestsLength/10)) {
            return res.redirect(`/profile/${req.params.id}/friends/page${Math.ceil(requestsLength/10)}`)
        }
        return res.render("user-friends", {userIdentifier, friends, pagenum, requestsLength})
    }
    return res.redirect("/")
})

// messages

app.get("/messages/page:page", loginChecker, (req, res) => {
    const pagenum = req.params.page
    const postStatements = db.prepare(`SELECT
        m.sender,
        m.recipient,
        m.id,
        m.title,
        m.body,
        sender.username AS sender_username,
        m.type,
        m.createdDate,
        recipient.username AS recipient_username
    FROM messages AS m
    JOIN users AS sender
        ON m.sender = sender.id
    JOIN users AS recipient
        ON m.recipient = recipient.id
    WHERE (m.sender = ? OR m.recipient = ?) AND m.type = 0 ORDER BY createdDate DESC LIMIT ? OFFSET ?;`)
    const userMessages = postStatements.all(req.user.userid, req.user.userid, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM messages WHERE (messages.sender = ? OR messages.recipient = ?) AND messages.type = 0")
    const commentslength = (lengthStatements.get(req.user.userid, req.user.userid))['COUNT(*)']

    if (pagenum > Math.ceil(commentslength/10)) {
        return res.redirect(`/messages/page${Math.ceil(commentslength/10)}`)
    }
    
    return res.render("messages", {userMessages, pagenum, commentslength})
})

app.get("/read-messages/page:page", loginChecker, (req, res) => {
    const pagenum = req.params.page
    const postStatements = db.prepare(`SELECT
        m.id,
        m.title,
        m.body,
        sender.username AS sender_username,
        m.type,
        m.createdDate,
        recipient.username AS recipient_username
    FROM messages AS m
    JOIN users AS sender
        ON m.sender = sender.id
    JOIN users AS recipient
        ON m.recipient = recipient.id
    WHERE (m.sender = ? OR m.recipient = ?) AND m.type = 1 ORDER BY createdDate DESC LIMIT ? OFFSET ?;`)
    const userMessages = postStatements.all(req.user.userid, req.user.userid, 10, ((pagenum-1)*10))

    const lengthStatements = db.prepare("SELECT COUNT(*) FROM messages WHERE (messages.sender = ? OR messages.recipient = ?) AND messages.type = 1")
    const commentslength = (lengthStatements.get(req.user.userid, req.user.userid))['COUNT(*)']

    if (pagenum > Math.ceil(commentslength/10)) {
        return res.redirect(`/read-messages/page${Math.ceil(commentslength/10)}`)
    }
    
    return res.render("read-messages", {userMessages, pagenum, commentslength})
})

app.get("/message/:id", loginChecker, (req, res) => {
    const postStatements = db.prepare(`SELECT * FROM messages WHERE id = ?`)
    const userMessages = postStatements.get(req.params.id)

    if (!userMessages) return res.redirect("/messages/page1")

    const senderStatement = db.prepare(`SELECT username FROM users WHERE id = ?`)
    const sender = senderStatement.get(userMessages.sender)

    const recipientStatement = db.prepare(`SELECT username FROM users WHERE id = ?`)
    const recipient = recipientStatement.get(userMessages.recipient)

    if (userMessages && (req.user.username == sender["username"] || req.user.username == recipient["username"])) return res.render("single-message", {userMessages, sender, recipient})
    return res.redirect("/messages/page1")
})



app.get("/send-message", loginChecker, (req, res) => {
    res.render("send-message")
})

app.get("/send-message/:id", loginChecker, (req, res) => {
    const checkUser = db.prepare("SELECT * FROM users WHERE id = ?")
    const getReqUser = checkUser.get(req.params.id)
    if (!getReqUser){
        res.redirect("/")
    }
    const currentUsername = getReqUser["username"]
    res.render("send-message", {currentUsername})
})

app.post("/send-message", loginChecker, (req, res) => {
    const errors = sharedPostValidation(req)

    // check if user exists

    const userCheckerStatement = db.prepare("SELECT * FROM users WHERE username = ?")
    const userResult = userCheckerStatement.get(req.body.recipient)

    if (!userResult) {
        errors.push("We couldn't find anyone with that username - maybe you misspelled it?")
    }

    if (errors.length) {
        return res.render("send-message", {errors})
    }

    // post submitted

    const ourStatement = db.prepare("INSERT INTO messages (sender, recipient, title, body, createdDate, type) VALUES (?,?,?,?,?,?)")
    const result = ourStatement.run(req.user.userid, userResult.id, req.body.title, req.body.body, new Date().toISOString(), 0)

    res.redirect(`/messages/page1`)
})

app.post("/read-message/:id", loginChecker, (req, res) => {

    const ourStatement = db.prepare("SELECT * FROM messages WHERE recipient = ? AND id = ?")
    const result = ourStatement.run(req.user.userid, req.params.id)

    if (!result) return res.redirect(`/messages/page1`)

    const updateStatement = db.prepare("UPDATE messages SET type = 1 WHERE id = ?")
    const update = updateStatement.run(req.params.id)

    return res.redirect(`/read-messages/page1`)

})

app.post("/unread-message/:id", loginChecker, (req, res) => {

    const ourStatement = db.prepare("SELECT * FROM messages WHERE recipient = ? AND id = ?")
    const result = ourStatement.run(req.user.userid, req.params.id)

    if (!result) return res.redirect(`/messages/page1`)

    const updateStatement = db.prepare("UPDATE messages SET type = 0 WHERE id = ?")
    const update = updateStatement.run(req.params.id)

    return res.redirect(`/read-messages/page1`)

})

// image handling

app.post("/api/upload-profile", loginChecker, uploadpfp.single('avatar'), (req, res) => {
 res.json(req.avatar)
})


app.use((req, res) => {
    res.status(404).render('404');
});

app.listen(3000) // don't care