struct Node {
    int val;
    Node* left;
    Node* right;
    Node(int v) : val(v), left(nullptr), right(nullptr) {}
};

Node* insert(Node* root, int v) {
    if (root == nullptr) {
        return new Node(v);
    }
    if (v < root->val) {
        root->left = insert(root->left, v);
    } else {
        root->right = insert(root->right, v);
    }
    return root;
}

int walk(Node* root) {
    if (root == nullptr) {
        return 0;
    }
    return root->val + walk(root->left) + walk(root->right);
}

int main() {
    Node* root = nullptr;
    root = insert(root, 5);
    root = insert(root, 3);
    root = insert(root, 8);
    root = insert(root, 1);
    return walk(root);
}
